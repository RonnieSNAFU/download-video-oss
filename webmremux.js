// Download Video OSS: reads a WebM byte stream (an init segment followed by clusters, exactly what a
// player appends to a SourceBuffer) and hands its frames to the muxer in webm.js, so a video stream
// and a separate audio stream can be written out as one file.
//   window.webmRemux([videoBytes, audioBytes]) -> Blob
(() => {
  const ID = {
    EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
    Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2,
    Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
    Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1,
  };

  // EBML integers: the first set bit says how many bytes the value occupies
  function vint(u8, pos, keepMarker) {
    const first = u8[pos];
    if (first === undefined) return null;
    let len = 1;
    for (let mask = 0x80; mask && !(first & mask); mask >>= 1) len++;
    if (len > 8) return null;
    let value = keepMarker ? first : first & (0xff >> len);
    let unknown = !keepMarker && (first & (0xff >> len)) === (0xff >> len);
    for (let i = 1; i < len; i++) {
      value = value * 256 + u8[pos + i];
      if (!keepMarker && u8[pos + i] !== 0xff) unknown = false;
    }
    return { value, len, unknown };
  }
  const uint = (u8, s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + u8[i]; return v; };
  const flt = (u8, s, e) => (e - s === 4 ? new DataView(u8.buffer, u8.byteOffset + s, 4).getFloat32(0)
    : e - s === 8 ? new DataView(u8.buffer, u8.byteOffset + s, 8).getFloat64(0) : 0);

  // walks one level of elements, calling back with (id, contentStart, contentEnd)
  function walk(u8, start, end, cb) {
    let p = start;
    while (p < end) {
      const id = vint(u8, p, true);
      if (!id) break;
      const size = vint(u8, p + id.len, false);
      if (!size) break;
      const content = p + id.len + size.len;
      // unknown-size elements (streamed Segment or Cluster) run to the end of what we have
      const stop = size.unknown ? end : Math.min(end, content + size.value);
      if (cb(id.value, content, stop) === 'descend') p = content;
      else p = size.unknown ? end : stop;
      if (stop <= p && !size.unknown && stop === content) p = content; // zero-length element
    }
  }

  // one captured stream -> track description plus its frames
  function parseStream(u8) {
    const tracks = new Map();
    const blocks = [];
    let timecodeScale = 1000000; // ns per tick
    let clusterTime = 0;
    const readTracks = (s, e) => walk(u8, s, e, (id, cs, ce) => {
      if (id !== ID.TrackEntry) return;
      const t = { number: 0, type: 0, codec: '', priv: null, width: 0, height: 0, rate: 48000, channels: 2 };
      walk(u8, cs, ce, (tid, ts, te) => {
        if (tid === ID.TrackNumber) t.number = uint(u8, ts, te);
        else if (tid === ID.TrackType) t.type = uint(u8, ts, te);
        else if (tid === ID.CodecID) t.codec = new TextDecoder().decode(u8.subarray(ts, te)).replace(/\0+$/, '');
        else if (tid === ID.CodecPrivate) t.priv = u8.slice(ts, te);
        else if (tid === ID.Video) walk(u8, ts, te, (vid, vs, ve) => {
          if (vid === ID.PixelWidth) t.width = uint(u8, vs, ve);
          else if (vid === ID.PixelHeight) t.height = uint(u8, vs, ve);
        });
        else if (tid === ID.Audio) walk(u8, ts, te, (aid, as_, ae) => {
          if (aid === ID.SamplingFrequency) t.rate = Math.round(flt(u8, as_, ae)) || 48000;
          else if (aid === ID.Channels) t.channels = uint(u8, as_, ae) || 2;
        });
      });
      if (t.number) tracks.set(t.number, t);
    });
    const readCluster = (s, e) => walk(u8, s, e, (id, cs, ce) => {
      if (id === ID.Timecode) clusterTime = uint(u8, cs, ce);
      else if (id === ID.SimpleBlock || id === ID.Block) {
        const tn = vint(u8, cs, false);
        if (!tn) return;
        const p = cs + tn.len;
        const rel = (u8[p] << 8 | u8[p + 1]) << 16 >> 16; // signed 16-bit
        const flags = u8[p + 2];
        if ((flags & 0x06) !== 0) return; // laced frames: not produced by the players we capture
        blocks.push({
          track: tn.value,
          ts: Math.round(((clusterTime + rel) * timecodeScale) / 1000), // microseconds
          key: id === ID.Block ? true : !!(flags & 0x80),
          data: u8.slice(p + 3, ce),
        });
      } else if (id === ID.BlockGroup) readCluster(cs, ce);
    });
    walk(u8, 0, u8.length, (id, cs, ce) => {
      if (id === ID.Segment) return 'descend';
      if (id === ID.Info) walk(u8, cs, ce, (iid, is, ie) => { if (iid === ID.TimecodeScale) timecodeScale = uint(u8, is, ie); });
      else if (id === ID.Tracks) readTracks(cs, ce);
      else if (id === ID.Cluster) readCluster(cs, ce);
    });
    return { tracks, blocks };
  }

  function webmRemux(streams) {
    let video = null, audio = null, lastTs = 0;
    for (const bytes of streams) {
      if (!bytes || !bytes.length) continue;
      const { tracks, blocks } = parseStream(bytes);
      for (const [num, t] of tracks) {
        const chunks = blocks.filter((b) => b.track === num).map((b) => ({ data: b.data, timestamp: b.ts, key: b.key }));
        if (!chunks.length) continue;
        lastTs = Math.max(lastTs, chunks[chunks.length - 1].timestamp);
        if (t.type === 1 && !video) video = { codec: t.codec, width: t.width, height: t.height, description: t.priv, chunks };
        else if (t.type === 2 && !audio) audio = { codec: t.codec, sampleRate: t.rate, channels: t.channels, description: t.priv, chunks };
      }
    }
    if (!video && !audio) throw new Error('no tracks found in the captured stream');
    const bytes = !video
      ? window.muxWebM({ video: { codec: audio.codec, width: 0, height: 0, chunks: audio.chunks, description: audio.description }, duration: lastTs })
      : window.muxWebM({ video, audio, duration: lastTs });
    return new Blob([bytes], { type: 'video/webm' });
  }

  window.webmRemux = webmRemux;
  window.webmParseStream = parseStream;
})();
