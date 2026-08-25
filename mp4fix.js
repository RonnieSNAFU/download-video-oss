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
  // Takes an array, never a spread: sample tables run to tens of thousands of entries and
  // f(...arr) overflows the call stack well before that.
  function u32a(vals) {
    const out = new Uint8Array(vals.length * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < vals.length; i++) dv.setUint32(i * 4, vals[i] >>> 0);
    return out;
  }
  const u32s = (...vals) => u32a(vals);
  function boxOf(type, payloads) { // box() without the spread
    let len = 8;
    for (const p of payloads) len += p.length;
    const out = new Uint8Array(len);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    out.set(te.encode(type), 4);
    let o = 8;
    for (const p of payloads) { out.set(p, o); o += p.length; }
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
  // files: array of fMP4 byte streams, each given as an array of parts (init segment + media
  // segments), e.g. [videoOnly, audioOnly]. All tracks are combined into one progressive MP4.
  //
  // Memory: the parts are never concatenated and the mdat is never materialised. Each part is
  // parsed where it lies, samples remember which part they came from, and the output is handed to
  // Blob as a list of views. Peak cost is the downloaded bytes themselves, not a multiple of them.
  function fmp4Merge(files) {
    const inputs = files.map((parts) => {
      let moovPart = -1, moov = null;
      for (let i = 0; i < parts.length && !moov; i++) {
        for (const bx of boxes(parts[i])) if (bx.type === 'moov') { moov = bx; moovPart = i; break; }
      }
      if (!moov) throw new Error('no moov');
      return { parts, moovU8: parts[moovPart], moov };
    });
    const first = inputs[0];
    const hdr = first.moovU8; // header boxes are read from the part holding the moov
    const mvhd = child(hdr, first.moov, 'mvhd');
    const movieTimescale = u32(hdr, mvhd.body + (hdr[mvhd.body] === 0 ? 12 : 20));

    // per track (across all inputs): collect samples from every moof, in every part
    const tracks = new Map(); // newId -> { moovU8, parts, trak, samples[], chunks[], newId }
    let nextId = 1;
    for (const inp of inputs) {
      const local = new Map(); // original track id -> track
      for (const trak of children(inp.moovU8, inp.moov, 'trak')) {
        const tkhd = child(inp.moovU8, trak, 'tkhd');
        const id = u32(inp.moovU8, tkhd.body + (inp.moovU8[tkhd.body] === 0 ? 12 : 20));
        const t = { moovU8: inp.moovU8, parts: inp.parts, trak, samples: [], chunks: [], newId: nextId++ };
        local.set(id, t);
        tracks.set(t.newId, t);
      }
      for (let p = 0; p < inp.parts.length; p++) {
        const part = inp.parts[p];
        for (const bx of boxes(part)) {
          if (bx.type !== 'moof') continue;
          for (const traf of children(part, bx, 'traf')) {
            const tfhd = child(part, traf, 'tfhd');
            const t = local.get(u32(part, tfhd.body + 4));
            if (!t) continue;
            for (const trun of children(part, traf, 'trun')) {
              const list = parseTrun(part, tfhd, trun, bx.start);
              if (!list.length) continue;
              t.chunks.push({ first: t.samples.length, count: list.length });
              for (const smp of list) { smp.part = p; t.samples.push(smp); } // no push(...list): stack
            }
          }
        }
      }
    }

    // interleave chunks by media time so video and audio stay close together in the file
    const allChunks = [];
    for (const [id, t] of tracks) {
      const mdhd = child(t.moovU8, child(t.moovU8, t.trak, 'mdia'), 'mdhd');
      const ts = u32(t.moovU8, mdhd.body + (t.moovU8[mdhd.body] === 0 ? 12 : 20));
      let tick = 0;
      for (const c of t.chunks) {
        allChunks.push({ id, c, time: tick / ts });
        for (let i = c.first; i < c.first + c.count; i++) tick += t.samples[i].dur;
      }
    }
    allChunks.sort((a, b) => a.time - b.time || a.id - b.id);
    let mdatSize = 0;
    for (const t of tracks.values()) for (const smp of t.samples) mdatSize += smp.size;

    let movieDuration = 0;
    const ftyp = box('ftyp', te.encode('isom'), u32s(0x200), te.encode('isomiso2avc1mp41'));

    function buildTrak(id, t, stcoOffsets) {
      const { trak, samples, moovU8: u8 } = t;
      const tkhd = child(u8, trak, 'tkhd');
      const mdia = child(u8, trak, 'mdia');
      const mdhd = child(u8, mdia, 'mdhd');
      const hdlr = child(u8, mdia, 'hdlr');
      const minf = child(u8, mdia, 'minf');
      const stbl = child(u8, minf, 'stbl');
      const stsd = child(u8, stbl, 'stsd');
      const mediaTimescale = u32(u8, mdhd.body + (u8[mdhd.body] === 0 ? 12 : 20));
      let durTicks = 0;
      for (const smp of samples) durTicks += smp.dur;
      movieDuration = Math.max(movieDuration, Math.round((durTicks / mediaTimescale) * movieTimescale));

      // stts (run-length durations)
      const stts = [];
      for (const smp of samples) {
        if (stts.length && stts[stts.length - 2] !== undefined && stts[stts.length - 1] === smp.dur) stts[stts.length - 2]++;
        else stts.push(1, smp.dur);
      }
      // ctts (composition offsets; parseTrun stores the offset itself in .cts)
      let hasCts = false, negCts = false;
      for (const smp of samples) { if (smp.cts !== 0) hasCts = true; if (smp.cts < 0) negCts = true; }
      const ctts = [];
      if (hasCts) for (const smp of samples) {
        if (ctts.length && ctts[ctts.length - 1] === smp.cts) ctts[ctts.length - 2]++;
        else ctts.push(1, smp.cts);
      }
      // stss (keyframes)
      const syncs = [];
      for (let i = 0; i < samples.length; i++) if (samples[i].sync) syncs.push(i + 1);
      const allSync = syncs.length === samples.length;
      // stsc (samples per chunk)
      const stsc = [];
      for (let i = 0; i < t.chunks.length; i++) {
        const c = t.chunks[i];
        if (stsc.length && stsc[stsc.length - 2] === c.count) continue;
        stsc.push(i + 1, c.count, 1);
      }
      // stsz (sizes)
      const sizes = new Array(samples.length + 2);
      sizes[0] = 0; sizes[1] = samples.length;
      for (let i = 0; i < samples.length; i++) sizes[i + 2] = samples[i].size;

      const stblParts = [
        slice(u8, stsd),
        fullBox('stts', 0, 0, u32a([stts.length / 2].concat(stts))),
      ];
      if (hasCts) stblParts.push(fullBox('ctts', negCts ? 1 : 0, 0, u32a([ctts.length / 2].concat(ctts))));
      if (!allSync) stblParts.push(fullBox('stss', 0, 0, u32a([syncs.length].concat(syncs))));
      stblParts.push(
        fullBox('stsc', 0, 0, u32a([stsc.length / 3].concat(stsc))),
        fullBox('stsz', 0, 0, u32a(sizes)),
        fullBox('stco', 0, 0, u32a([stcoOffsets.length].concat(stcoOffsets))),
      );
      const stblBox = boxOf('stbl', stblParts);

      const minfParts = [];
      for (const bx of boxes(u8, minf.body, minf.end)) if (bx.type !== 'stbl') minfParts.push(slice(u8, bx));
      minfParts.push(stblBox);
      const mdiaBox = box('mdia', patchDuration(u8, mdhd, 'mdhd', durTicks), slice(u8, hdlr), boxOf('minf', minfParts));
      const tkhdBox = patchDuration(u8, tkhd, 'tkhd', Math.round((durTicks / mediaTimescale) * movieTimescale));
      new DataView(tkhdBox.buffer).setUint32(tkhdBox[8] === 0 ? 20 : 28, t.newId); // track_ID
      return box('trak', tkhdBox, mdiaBox);
    }

    function buildMoov(offsetsByTrack) {
      const mvhdBox = patchDuration(hdr, mvhd, 'mvhd', movieDuration);
      new DataView(mvhdBox.buffer).setUint32(mvhdBox.length - 4, nextId); // next_track_ID
      const parts = [mvhdBox];
      for (const [id, t] of tracks) parts.push(buildTrak(id, t, offsetsByTrack.get(id) || []));
      return boxOf('moov', parts);
    }

    // The moov carries chunk offsets, and its own size shifts them, so build it twice: once with
    // placeholders to learn the size, then again with the real offsets.
    const placeholder = new Map();
    for (const [id, t] of tracks) placeholder.set(id, t.chunks.map(() => 0));
    const moovSize = buildMoov(placeholder).length;
    const large = mdatSize + 8 > 0xfffffff0;
    const mdatHeaderSize = large ? 16 : 8;
    const mdatStart = ftyp.length + moovSize + mdatHeaderSize;

    // media data: views into the parts we already hold, in chunk order. Nothing is copied here.
    const offsets = new Map();
    for (const id of tracks.keys()) offsets.set(id, []);
    const mdatViews = [];
    let pos = mdatStart;
    for (const { id, c } of allChunks) {
      offsets.get(id).push(pos);
      const t = tracks.get(id);
      for (let i = c.first; i < c.first + c.count; i++) {
        const smp = t.samples[i];
        mdatViews.push(t.parts[smp.part].subarray(smp.offset, smp.offset + smp.size));
        pos += smp.size;
      }
    }
    const moovBox = buildMoov(offsets);
    if (moovBox.length !== moovSize) throw new Error('moov size mismatch');

    const mdatHeader = new Uint8Array(mdatHeaderSize);
    const mh = new DataView(mdatHeader.buffer);
    if (large) {
      mh.setUint32(0, 1); mdatHeader.set(te.encode('mdat'), 4);
      mh.setUint32(8, Math.floor((mdatSize + 16) / 4294967296)); mh.setUint32(12, (mdatSize + 16) >>> 0);
    } else {
      mh.setUint32(0, mdatSize + 8); mdatHeader.set(te.encode('mdat'), 4);
    }
    return new Blob([ftyp, moovBox, mdatHeader].concat(mdatViews), { type: 'video/mp4' });
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
