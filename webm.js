// Download Video OSS: minimal WebM (Matroska/EBML) muxer for WebCodecs output.
// window.muxWebM({ video:{codec:'V_VP9'|'V_AV1'|'V_VP8', width, height, description?, chunks:[{data:Uint8Array, timestamp:µs, key:bool}]},
//                  audio?:{codec:'A_OPUS'|'A_VORBIS', sampleRate, channels, description?, chunks:[...]}, duration:µs }) -> Uint8Array
(() => {
  const te = new TextEncoder();
  // ---------- EBML primitives ----------
  function vint(n) { // EBML element size (variable-length int)
    if (n < 0x7f) return new Uint8Array([0x80 | n]);
    if (n < 0x3fff) return new Uint8Array([0x40 | (n >> 8), n & 255]);
    if (n < 0x1fffff) return new Uint8Array([0x20 | (n >> 16), (n >> 8) & 255, n & 255]);
    if (n < 0x0fffffff) return new Uint8Array([0x10 | (n >> 24), (n >> 16) & 255, (n >> 8) & 255, n & 255]);
    // 8-byte size for anything larger
    const out = new Uint8Array(8); out[0] = 0x01;
    let v = n; for (let i = 7; i >= 1; i--) { out[i] = v & 255; v = Math.floor(v / 256); }
    return out;
  }
  const idBytes = (id) => { const b = []; do { b.unshift(id & 255); id = Math.floor(id / 256); } while (id > 0); return new Uint8Array(b); };
  function concat(arrs) { const n = arrs.reduce((a, b) => a + b.length, 0); const out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; }
  function el(id, payload) { const p = ArrayBuffer.isView(payload) ? payload : concat(payload); return concat([idBytes(id), vint(p.length), p]); }
  function uintBytes(v) { const b = []; do { b.unshift(v & 255); v = Math.floor(v / 256); } while (v > 0); return new Uint8Array(b); }
  const U = (id, v) => el(id, uintBytes(v));
  const S = (id, s) => el(id, te.encode(s));
  const F = (id, v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return el(id, b); };
  const B = (id, bytes) => el(id, bytes);

  // ---------- element IDs ----------
  const ID = {
    EBML: 0x1A45DFA3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42F7, EBMLMaxIDLength: 0x42F2, EBMLMaxSizeLength: 0x42F3, DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
    Segment: 0x18538067, Info: 0x1549A966, TimecodeScale: 0x2AD7B1, MuxingApp: 0x4D80, WritingApp: 0x5741, Duration: 0x4489,
    Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackUID: 0x73C5, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63A2, CodecDelay: 0x56AA, SeekPreRoll: 0x56BB,
    Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA, Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F,
    Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3,
    Cues: 0x1C53BB6B, CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueTrack: 0xF7, CueClusterPosition: 0xF1,
    SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC, Void: 0xEC,
  };

  function simpleBlock(trackNo, relMs, key, data) {
    const hdr = new Uint8Array(4);
    hdr[0] = 0x80 | trackNo; // track number as 1-byte vint
    hdr[1] = (relMs >> 8) & 255; hdr[2] = relMs & 255;
    hdr[3] = key ? 0x80 : 0x00;
    return el(ID.SimpleBlock, concat([hdr, data]));
  }

  function muxWebM({ video, audio, duration }) {
    const tracks = [];
    const trackEntry = (no, t, isVideo) => {
      const parts = [U(ID.TrackNumber, no), U(ID.TrackUID, no), U(ID.TrackType, isVideo ? 1 : 2), S(ID.CodecID, t.codec)];
      if (t.description && t.description.length) parts.push(B(ID.CodecPrivate, t.description));
      if (isVideo) parts.push(el(ID.Video, [U(ID.PixelWidth, t.width), U(ID.PixelHeight, t.height)]));
      else {
        if (t.codec === 'A_OPUS') { parts.push(U(ID.CodecDelay, 6500000), U(ID.SeekPreRoll, 80000000)); }
        parts.push(el(ID.Audio, [F(ID.SamplingFrequency, t.sampleRate), U(ID.Channels, t.channels)]));
      }
      return el(ID.TrackEntry, parts);
    };
    tracks.push(trackEntry(1, video, true));
    if (audio) tracks.push(trackEntry(2, audio, false));

    // merge blocks by timestamp; clusters start at video keyframes (or every 5 s)
    const blocks = [];
    for (const c of video.chunks) blocks.push({ track: 1, ts: c.timestamp, key: !!c.key, data: c.data });
    if (audio) for (const c of audio.chunks) blocks.push({ track: 2, ts: c.timestamp, key: true, data: c.data });
    blocks.sort((a, b) => a.ts - b.ts || a.track - b.track);
    const t0 = blocks.length ? blocks[0].ts : 0;
    const ms = (us) => Math.round((us - t0) / 1000);

    const clusters = []; // { timeMs, bytes }
    let cur = null, curBlocks = [];
    const flush = () => { if (cur !== null) { clusters.push({ timeMs: cur, bytes: el(ID.Cluster, [U(ID.Timecode, cur), ...curBlocks]) }); } cur = null; curBlocks = []; };
    for (const b of blocks) {
      const t = ms(b.ts);
      const needNew = cur === null || (b.track === 1 && b.key && t - cur >= 1000) || t - cur > 30000;
      if (needNew) { flush(); cur = t; }
      curBlocks.push(simpleBlock(b.track, Math.max(0, Math.min(32767, t - cur)), b.key, b.data));
    }
    flush();

    const durMs = duration ? duration / 1000 : (blocks.length ? ms(blocks[blocks.length - 1].ts) + 40 : 0);
    const info = el(ID.Info, [U(ID.TimecodeScale, 1000000), S(ID.MuxingApp, 'Download Video OSS'), S(ID.WritingApp, 'Download Video OSS'), F(ID.Duration, durMs)]);
    const tracksEl = el(ID.Tracks, tracks);

    // layout: [EBML][Segment: SeekHead, Void, Info, Tracks, Clusters..., Cues]
    // Cues need cluster positions relative to the Segment data start -> two-step sizing.
    const seekHeadSize = (() => { // fixed-size seek head for Info/Tracks/Cues using 8-byte positions
      const mk = (id, pos) => el(ID.Seek, [B(ID.SeekID, idBytes(id)), el(ID.SeekPosition, (() => { const b = new Uint8Array(8); new DataView(b.buffer).setUint32(4, pos); return b; })())]);
      return el(ID.SeekHead, [mk(ID.Info, 0), mk(ID.Tracks, 0), mk(ID.Cues, 0)]).length;
    })();
    const voidEl = el(ID.Void, new Uint8Array(32));
    let pos = seekHeadSize + voidEl.length;
    const infoPos = pos; pos += info.length;
    const tracksPos = pos; pos += tracksEl.length;
    const clusterPos = [];
    for (const c of clusters) { clusterPos.push(pos); pos += c.bytes.length; }
    const cuesPos = pos;
    const cuePoints = clusters.map((c, i) => el(ID.CuePoint, [U(ID.CueTime, c.timeMs), el(ID.CueTrackPositions, [U(ID.CueTrack, 1), U(ID.CueClusterPosition, clusterPos[i])])]));
    const cues = el(ID.Cues, cuePoints);
    const seekHead = (() => {
      const mk = (id, p) => el(ID.Seek, [B(ID.SeekID, idBytes(id)), el(ID.SeekPosition, (() => { const b = new Uint8Array(8); new DataView(b.buffer).setUint32(4, p); return b; })())]);
      return el(ID.SeekHead, [mk(ID.Info, infoPos), mk(ID.Tracks, tracksPos), mk(ID.Cues, cuesPos)]);
    })();
    const segmentBody = concat([seekHead, voidEl, info, tracksEl, ...clusters.map((c) => c.bytes), cues]);
    const ebml = el(ID.EBML, [U(ID.EBMLVersion, 1), U(ID.EBMLReadVersion, 1), U(ID.EBMLMaxIDLength, 4), U(ID.EBMLMaxSizeLength, 8), S(ID.DocType, 'webm'), U(ID.DocTypeVersion, 4), U(ID.DocTypeReadVersion, 2)]);
    return concat([ebml, el(ID.Segment, segmentBody)]);
  }

  (typeof window !== 'undefined' ? window : globalThis).muxWebM = muxWebM;
})();
