// Converts the fragmented MP4 emitted by mux.js (init moov + N × moof/mdat) into a
// standard progressive MP4 (ftyp + moov with full sample tables + one mdat) so
// players can seek properly.  Exposes window.fmp4ToProgressive(parts: Uint8Array[]).
(() => {
  const te = new TextEncoder();
  const str4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  const u32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const i32 = (u8, o) => (u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3];
  const u64 = (u8, o) => u32(u8, o) * 4294967296 + u32(u8, o + 4);

  function* boxes(u8, start = 0, end = u8.length) {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(u8, o);
      const type = str4(u8, o + 4);
      let hdr = 8;
      if (size === 1) { size = u64(u8, o + 8); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr) break;
      yield { type, start: o, end: o + size, body: o + hdr };
      o += size;
    }
  }
  const child = (u8, box, type) => { for (const b of boxes(u8, box.body, box.end)) if (b.type === type) return b; };
  const children = (u8, box, type) => [...boxes(u8, box.body, box.end)].filter((b) => b.type === type);

  // ---------- box writers ----------
  function box(type, ...payloads) {
    const len = payloads.reduce((n, p) => n + p.length, 0) + 8;
    const out = new Uint8Array(len);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    out.set(te.encode(type), 4);
    let o = 8;
    for (const p of payloads) { out.set(p, o); o += p.length; }
    return out;
  }
  function u32s(...vals) {
    const out = new Uint8Array(vals.length * 4);
    const dv = new DataView(out.buffer);
    vals.forEach((v, i) => dv.setUint32(i * 4, v >>> 0));
    return out;
  }
  function fullBox(type, version, flags, payload) {
    return box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), payload);
  }
  function slice(u8, b) { return u8.subarray(b.start, b.end); }

  function patchDuration(u8, b, kind, duration) {
    // copy of the box with its duration field set; offsets are from box start
    const out = new Uint8Array(slice(u8, b));
    const version = out[8];
    const dv = new DataView(out.buffer);
    const off = kind === 'tkhd' ? (version === 0 ? 28 : 36) : (version === 0 ? 24 : 32);
    if (version === 0) dv.setUint32(off, Math.min(duration, 0xffffffff));
    else { dv.setUint32(off, Math.floor(duration / 4294967296)); dv.setUint32(off + 4, duration >>> 0); }
    return out;
  }

  // ---------- fragment parsing ----------
  function parseTrun(u8, tfhd, trun, moofStart) {
    const tfFlags = u32(u8, tfhd.body) & 0xffffff;
    let o = tfhd.body + 8; // version/flags + track_ID
    let baseOffset = moofStart;
    if (tfFlags & 0x1) { baseOffset = u64(u8, o); o += 8; }
    if (tfFlags & 0x2) o += 4;
    const defDur = tfFlags & 0x8 ? u32(u8, (o += 4) - 4) : 0;
    const defSize = tfFlags & 0x10 ? u32(u8, (o += 4) - 4) : 0;
    const defFlags = tfFlags & 0x20 ? u32(u8, (o += 4) - 4) : 0;

    const version = u8[trun.body];
    const flags = u32(u8, trun.body) & 0xffffff;
    let p = trun.body + 4;
    const count = u32(u8, p); p += 4;
    let dataOffset = 0;
    if (flags & 0x1) { dataOffset = i32(u8, p); p += 4; }
    let firstFlags = null;
    if (flags & 0x4) { firstFlags = u32(u8, p); p += 4; }
    const samples = [];
    let pos = baseOffset + dataOffset;
    for (let i = 0; i < count; i++) {
      let dur = defDur, size = defSize, fl = defFlags, cts = 0;
      if (flags & 0x100) { dur = u32(u8, p); p += 4; }
      if (flags & 0x200) { size = u32(u8, p); p += 4; }
      if (flags & 0x400) { fl = u32(u8, p); p += 4; }
      if (flags & 0x800) { cts = version === 0 ? u32(u8, p) : i32(u8, p); p += 4; }
      if (i === 0 && firstFlags !== null) fl = firstFlags;
      const sync = ((fl >> 16) & 0x1) === 0; // sample_is_non_sync_sample bit clear => keyframe
      samples.push({ dur, size, cts, sync, offset: pos });
      pos += size;
    }
    return samples;
  }

  // ---------- main ----------
  // files: array of fMP4 byte streams (each = init moov + moof/mdat...), e.g. [videoOnly, audioOnly].
  // All tracks are combined into one progressive MP4.
  function fmp4Merge(files) {
    const inputs = files.map((parts) => {
      const total = parts.reduce((n, p) => n + p.length, 0);
      const u8 = new Uint8Array(total);
      let w = 0;
      for (const p of parts) { u8.set(p, w); w += p.length; }
      const top = [...boxes(u8)];
      const moov = top.find((b) => b.type === 'moov');
      if (!moov) throw new Error('no moov');
      return { u8, top, moov };
    });
    const first = inputs[0];
    const u8 = first.u8; // for mvhd
    const mvhd = child(first.u8, first.moov, 'mvhd');
    const movieTimescale = u32(first.u8, mvhd.body + (first.u8[mvhd.body] === 0 ? 12 : 20));

    // per track (across all inputs): collect samples from every moof
    const tracks = new Map(); // newId -> { u8, trak, samples[], chunks[], newId }
    let nextId = 1;
    for (const inp of inputs) {
      const local = new Map(); // original id -> track
      for (const trak of children(inp.u8, inp.moov, 'trak')) {
        const tkhd = child(inp.u8, trak, 'tkhd');
        const id = u32(inp.u8, tkhd.body + (inp.u8[tkhd.body] === 0 ? 12 : 20));
        const t = { u8: inp.u8, trak, samples: [], chunks: [], newId: nextId++ };
        local.set(id, t);
        tracks.set(t.newId, t);
      }
      for (const moof of inp.top.filter((b) => b.type === 'moof')) {
        for (const traf of children(inp.u8, moof, 'traf')) {
          const tfhd = child(inp.u8, traf, 'tfhd');
          const t = local.get(u32(inp.u8, tfhd.body + 4));
          if (!t) continue;
          for (const trun of children(inp.u8, traf, 'trun')) {
            const s = parseTrun(inp.u8, tfhd, trun, moof.start);
            if (!s.length) continue;
            t.chunks.push({ first: t.samples.length, count: s.length });
            t.samples.push(...s);
          }
        }
      }
    }

    // interleave chunks in file order (by source offset) and build one mdat
    const allChunks = [];
    for (const [id, t] of tracks) {
      const mdhd = child(t.u8, child(t.u8, t.trak, 'mdia'), 'mdhd');
      const ts = u32(t.u8, mdhd.body + (t.u8[mdhd.body] === 0 ? 12 : 20));
      let tick = 0;
      for (const c of t.chunks) {
        allChunks.push({ id, c, time: tick / ts });
        for (let i = c.first; i < c.first + c.count; i++) tick += t.samples[i].dur;
      }
    }
    allChunks.sort((a, b) => a.time - b.time || a.id - b.id);
    let mdatSize = 0;
    for (const t of tracks.values()) for (const s of t.samples) mdatSize += s.size;

    let movieDuration = 0;

    // Assign chunk offsets now (moov size depends on sample tables, so build moov first with
    // placeholder offsets, then rewrite stco once ftyp+moov size is known).
    const ftyp = box('ftyp', te.encode('isom'), u32s(0x200), te.encode('isomiso2avc1mp41'));

    function buildTrak(id, t, stcoOffsets) {
      const { trak, samples, u8 } = t;
      const tkhd = child(u8, trak, 'tkhd');
      const mdia = child(u8, trak, 'mdia');
      const mdhd = child(u8, mdia, 'mdhd');
      const hdlr = child(u8, mdia, 'hdlr');
      const minf = child(u8, mdia, 'minf');
      const stbl = child(u8, minf, 'stbl');
      const stsd = child(u8, stbl, 'stsd');
      const mediaTimescale = u32(u8, mdhd.body + (u8[mdhd.body] === 0 ? 12 : 20));
      const durTicks = samples.reduce((n, s) => n + s.dur, 0);
      movieDuration = Math.max(movieDuration, Math.round((durTicks / mediaTimescale) * movieTimescale));

      // stts (run-length durations)
      const stts = [];
      for (const s of samples) {
        if (stts.length && stts[stts.length - 1][1] === s.dur) stts[stts.length - 1][0]++;
        else stts.push([1, s.dur]);
      }
      // ctts
      const hasCts = samples.some((s) => s.cts !== 0);
      const ctts = [];
      if (hasCts) for (const s of samples) {
        if (ctts.length && ctts[ctts.length - 1][1] === s.cts) ctts[ctts.length - 1][0]++;
        else ctts.push([1, s.cts]);
      }
      // stss
      const syncs = samples.map((s, i) => (s.sync ? i + 1 : 0)).filter(Boolean);
      const allSync = syncs.length === samples.length;
      // stsc
      const stsc = [];
      t.chunks.forEach((c, i) => {
        if (stsc.length && stsc[stsc.length - 1][1] === c.count) return;
        stsc.push([i + 1, c.count]);
      });

      const stblBox = box('stbl',
        slice(u8, stsd),
        fullBox('stts', 0, 0, u32s(stts.length, ...stts.flat())),
        ...(hasCts ? [fullBox('ctts', 0, 0, u32s(ctts.length, ...ctts.flat()))] : []),
        ...(allSync ? [] : [fullBox('stss', 0, 0, u32s(syncs.length, ...syncs))]),
        fullBox('stsc', 0, 0, u32s(stsc.length, ...stsc.flatMap(([f, c]) => [f, c, 1]))),
        fullBox('stsz', 0, 0, u32s(0, samples.length, ...samples.map((s) => s.size))),
        fullBox('stco', 0, 0, u32s(stcoOffsets.length, ...stcoOffsets)),
      );
      const minfBox = box('minf',
        ...[...boxes(u8, minf.body, minf.end)].filter((b) => b.type !== 'stbl').map((b) => slice(u8, b)),
        stblBox,
      );
      const mdiaBox = box('mdia', patchDuration(u8, mdhd, 'mdhd', durTicks), slice(u8, hdlr), minfBox);
      const tkhdBox = patchDuration(u8, tkhd, 'tkhd', Math.round((durTicks / mediaTimescale) * movieTimescale));
      new DataView(tkhdBox.buffer).setUint32(tkhdBox[8] === 0 ? 20 : 28, t.newId); // track_ID
      return box('trak', tkhdBox, mdiaBox);
    }

    function buildMoov(offsetsByTrack) {
      const traks = [];
      for (const [id, t] of tracks) traks.push(buildTrak(id, t, offsetsByTrack.get(id) || []));
      const mvhdBox = patchDuration(u8, mvhd, 'mvhd', movieDuration);
      new DataView(mvhdBox.buffer).setUint32(mvhdBox.length - 4, nextId); // next_track_ID
      return box('moov', mvhdBox, ...traks);
    }

    // pass 1: placeholder offsets to learn moov size
    const placeholder = new Map();
    for (const [id, t] of tracks) placeholder.set(id, t.chunks.map(() => 0));
    const moovSize = buildMoov(placeholder).length;
    const mdatStart = ftyp.length + moovSize + 8;

    // pass 2: real offsets
    const offsets = new Map();
    for (const id of tracks.keys()) offsets.set(id, []);
    let pos = mdatStart;
    const mdat = new Uint8Array(mdatSize);
    let mw = 0;
    for (const { id, c } of allChunks) {
      offsets.get(id).push(pos);
      const t = tracks.get(id);
      for (let i = c.first; i < c.first + c.count; i++) {
        const s = t.samples[i];
        mdat.set(t.u8.subarray(s.offset, s.offset + s.size), mw);
        mw += s.size; pos += s.size;
      }
    }
    const moovBox = buildMoov(offsets);
    if (moovBox.length !== moovSize) throw new Error('moov size mismatch');
    return new Blob([ftyp, moovBox, box('mdat', mdat)], { type: 'video/mp4' });
  }


  // ---------- progressive MP4 reader (for WebCodecs) ----------
  // Returns [{ kind:'video'|'audio', codec, description (Uint8Array|null), timescale, width, height,
  //            sampleRate, channels, samples:[{offset,size,dts,cts,dur,sync}] }]
  function parseMp4Samples(u8) {
    const top = [...boxes(u8)];
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) throw new Error('no moov (not a progressive MP4)');
    const out = [];
    for (const trak of children(u8, moov, 'trak')) {
      const mdia = child(u8, trak, 'mdia');
      const hdlr = child(u8, mdia, 'hdlr');
      const handler = str4(u8, hdlr.body + 8);
      if (handler !== 'vide' && handler !== 'soun') continue;
      const mdhd = child(u8, mdia, 'mdhd');
      const timescale = u32(u8, mdhd.body + (u8[mdhd.body] === 0 ? 12 : 20));
      const stbl = child(u8, child(u8, mdia, 'minf'), 'stbl');
      const stsd = child(u8, stbl, 'stsd');
      const entry = [...boxes(u8, stsd.body + 8, stsd.end)][0];
      if (!entry) continue;
      const t = { kind: handler === 'vide' ? 'video' : 'audio', codec: entry.type, description: null, timescale, samples: [] };
      if (t.kind === 'video') {
        t.width = (u8[entry.body + 24] << 8) | u8[entry.body + 25];
        t.height = (u8[entry.body + 26] << 8) | u8[entry.body + 27];
        const avcC = child(u8, { body: entry.body + 78, end: entry.end }, 'avcC');
        const hvcC = child(u8, { body: entry.body + 78, end: entry.end }, 'hvcC');
        if (avcC) {
          t.description = u8.slice(avcC.body, avcC.end);
          const hx = (n) => n.toString(16).padStart(2, '0');
          t.codec = `avc1.${hx(u8[avcC.body + 1])}${hx(u8[avcC.body + 2])}${hx(u8[avcC.body + 3])}`;
        } else if (hvcC) { t.description = u8.slice(hvcC.body, hvcC.end); t.codec = 'hev1.1.6.L93.B0'; }
      } else {
        t.channels = (u8[entry.body + 16] << 8) | u8[entry.body + 17];
        t.sampleRate = u32(u8, entry.body + 24) >>> 16;
        const esds = child(u8, { body: entry.body + 28, end: entry.end }, 'esds');
        if (esds) {
          // walk ES_Descriptor -> DecoderConfig -> DecoderSpecificInfo (AudioSpecificConfig)
          let p = esds.body + 4;
          const readLen = () => { let n = 0, b; do { b = u8[p++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
          if (u8[p] === 0x03) { p++; readLen(); p += 3; }
          if (u8[p] === 0x04) { p++; readLen(); const oti = u8[p]; p += 13; if (u8[p] === 0x05) { p++; const n = readLen(); t.description = u8.slice(p, p + n); }
            t.codec = oti === 0x40 ? 'mp4a.40.2' : oti === 0x6b ? 'mp3' : `mp4a.${oti.toString(16)}`; }
          if (t.description && t.description.length >= 2) { const aot = t.description[0] >> 3; t.codec = `mp4a.40.${aot || 2}`; }
        }
      }
      const fb = (type) => child(u8, stbl, type);
      const stts = fb('stts'), ctts = fb('ctts'), stsc = fb('stsc'), stsz = fb('stsz'), stco = fb('stco') || fb('co64'), stss = fb('stss');
      if (!stts || !stsc || !stsz || !stco) continue;
      // sizes
      const count = u32(u8, stsz.body + 8);
      const fixed = u32(u8, stsz.body + 4);
      const sizes = new Array(count);
      for (let i = 0; i < count; i++) sizes[i] = fixed || u32(u8, stsz.body + 12 + i * 4);
      // durations
      const durs = new Array(count); { let i = 0; const n = u32(u8, stts.body + 4); for (let e = 0; e < n; e++) { const c = u32(u8, stts.body + 8 + e * 8), d = u32(u8, stts.body + 12 + e * 8); for (let k = 0; k < c && i < count; k++) durs[i++] = d; } while (i < count) durs[i++] = durs[i - 2] || 0; }
      const ctsOff = new Array(count).fill(0);
      if (ctts) { let i = 0; const n = u32(u8, ctts.body + 4); const v1 = u8[ctts.body] === 1; for (let e = 0; e < n; e++) { const c = u32(u8, ctts.body + 8 + e * 8), o = v1 ? i32(u8, ctts.body + 12 + e * 8) : u32(u8, ctts.body + 12 + e * 8); for (let k = 0; k < c && i < count; k++) ctsOff[i++] = o; } }
      const syncs = new Set();
      if (stss) { const n = u32(u8, stss.body + 4); for (let i = 0; i < n; i++) syncs.add(u32(u8, stss.body + 8 + i * 4) - 1); }
      // chunks
      const co64 = stco.type === 'co64';
      const nChunks = u32(u8, stco.body + 4);
      const chunkOff = new Array(nChunks);
      for (let i = 0; i < nChunks; i++) chunkOff[i] = co64 ? u64(u8, stco.body + 8 + i * 8) : u32(u8, stco.body + 8 + i * 4);
      const nStsc = u32(u8, stsc.body + 4);
      const runs = [];
      for (let i = 0; i < nStsc; i++) runs.push({ first: u32(u8, stsc.body + 8 + i * 12) - 1, per: u32(u8, stsc.body + 12 + i * 12) });
      let si = 0, dts = 0;
      for (let ci = 0; ci < nChunks && si < count; ci++) {
        let per = runs[0].per;
        for (const r of runs) if (ci >= r.first) per = r.per;
        let off = chunkOff[ci];
        for (let k = 0; k < per && si < count; k++, si++) {
          t.samples.push({ offset: off, size: sizes[si], dts, cts: dts + ctsOff[si], dur: durs[si], sync: stss ? syncs.has(si) : true });
          off += sizes[si]; dts += durs[si];
        }
      }
      out.push(t);
    }
    return out;
  }

  const fmp4ToProgressive = (parts) => fmp4Merge([parts]);
  const g = typeof window !== 'undefined' ? window : globalThis;
  g.fmp4ToProgressive = fmp4ToProgressive;
  g.fmp4Merge = fmp4Merge;
  g.parseMp4Samples = parseMp4Samples;
})();
