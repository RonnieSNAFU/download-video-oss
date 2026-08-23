// Download Video OSS: in-page preview loader (injected on demand together with mux.min.js + mp4fix.js).
// Assembles a streaming source (HLS / merged streams) into a playable MP4 blob *from the page's origin*,
// so the clip editor gets its own independent player instead of mirroring whatever the site is playing.
//   window.DVOPreview.load(candidate, onProgress) -> { url: blobURL, bytes }
(() => {
  const CONCURRENCY = 6;
  const cache = new Map(); // candidateId -> { url, bytes }

  const fetchBuf = async (url, tries = 3) => {
    for (let i = 0; ; i++) {
      try { const r = await fetch(url, { credentials: 'include' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.arrayBuffer(); }
      catch (e) { if (i >= tries - 1) throw e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
    }
  };
  const fetchText = async (u) => new TextDecoder().decode(await fetchBuf(u));
  const parseAttrs = (s) => { const o = {}; for (const m of s.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) o[m[1]] = m[3] !== undefined ? m[3] : m[2]; return o; };

  function parseMedia(text, base) {
    const segs = []; let map = null, key = null, seq = 0;
    for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = +line.split(':')[1] || 0;
      else if (line.startsWith('#EXT-X-MAP:')) map = new URL(parseAttrs(line.slice(11)).URI, base).href;
      else if (line.startsWith('#EXT-X-KEY:')) { const a = parseAttrs(line.slice(11)); key = a.METHOD === 'NONE' ? null : a.METHOD === 'AES-128' ? { uri: new URL(a.URI, base).href, iv: a.IV || null } : (() => { throw new Error('DRM'); })(); }
      else if (!line.startsWith('#')) segs.push({ url: new URL(line, base).href, key, seq: seq++, map });
    }
    return segs;
  }
  // preview: prefer a variant around 480-720p (faster), audio rendition if any
  function pickVariant(text, base) {
    const lines = text.split(/\r?\n/); const audio = new Map(); const vars = [];
    for (const l of lines) if (l.startsWith('#EXT-X-MEDIA:')) { const a = parseAttrs(l.slice(13)); if (a.TYPE === 'AUDIO' && a.URI && (!audio.has(a['GROUP-ID']) || a.DEFAULT === 'YES')) audio.set(a['GROUP-ID'], new URL(a.URI, base).href); }
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = parseAttrs(lines[i].slice(18)); const next = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
      if (!next) continue;
      const h = +((a.RESOLUTION || '0x0').split('x')[1]) || 0;
      vars.push({ h, bw: +(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || 0), uri: new URL(next.trim(), base).href, audioUri: a.AUDIO ? audio.get(a.AUDIO) || null : null });
    }
    if (!vars.length) throw new Error('no variants');
    vars.sort((x, y) => x.bw - y.bw);
    return vars.find((v) => v.h >= 480) || vars[vars.length - 1];
  }
  const keyCache = new Map();
  async function decrypt(buf, seg) {
    if (!seg.key) return buf;
    let ck = keyCache.get(seg.key.uri);
    if (!ck) { ck = await crypto.subtle.importKey('raw', await fetchBuf(seg.key.uri), { name: 'AES-CBC' }, false, ['decrypt']); keyCache.set(seg.key.uri, ck); }
    const iv = new Uint8Array(16);
    if (seg.key.iv) { const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0'); for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16); } else new DataView(iv.buffer).setUint32(12, seg.seq);
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, buf);
  }
  async function fetchPlaylist(url, progress) {
    const segs = parseMedia(await fetchText(url), url);
    if (!segs.length) throw new Error('empty playlist');
    const bufs = new Array(segs.length); let done = 0, next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (next < segs.length) { const i = next++; bufs[i] = await decrypt(await fetchBuf(segs[i].url), segs[i]); progress(++done, segs.length); } }));
    const isFmp4 = !!segs[0].map || new Uint8Array(bufs[0])[0] !== 0x47;
    if (!isFmp4) return { parts: bufs, isFmp4 };
    const parts = []; let last = null;
    for (let i = 0; i < segs.length; i++) { if (segs[i].map && segs[i].map !== last) { parts.push(new Uint8Array(await fetchBuf(segs[i].map))); last = segs[i].map; } parts.push(new Uint8Array(bufs[i])); }
    return { parts, isFmp4 };
  }
  function remuxTs(bufs) {
    const parts = []; const t = new muxjs.mp4.Transmuxer({ remux: true }); let init = false;
    t.on('data', (s) => { if (!init) { parts.push(s.initSegment); init = true; } parts.push(s.data); });
    for (const b of bufs) { t.push(new Uint8Array(b)); t.flush(); }
    if (!init) throw new Error('remux produced no output');
    return fmp4ToProgressive(parts);
  }
  async function loadHls(url, onProgress) {
    const text = await fetchText(url);
    let v = { uri: url, audioUri: null };
    if (/#EXT-X-STREAM-INF/.test(text)) v = pickVariant(text, url);
    const prog = [0, 0], tot = [0, 0];
    const upd = (i) => (d, t) => { prog[i] = d; tot[i] = t; const D = prog[0] + prog[1], T = tot[0] + tot[1]; onProgress(T ? Math.round((D / T) * 90) : 0, `${D}/${T} segments`); };
    const [video, audio] = await Promise.all([fetchPlaylist(v.uri, upd(0)), v.audioUri ? fetchPlaylist(v.audioUri, upd(1)) : null]);
    onProgress(95, 'building preview…');
    if (!video.isFmp4) return remuxTs(video.parts);
    if (audio && audio.isFmp4) return fmp4Merge([video.parts, audio.parts]);
    return fmp4ToProgressive(video.parts);
  }
  const CHUNK = 10 * 1024 * 1024;
  async function fetchChunked(url, size, onBytes) {
    const u = new URL(url); const gv = /\.googlevideo\.com$/i.test(u.hostname); const parts = []; let pos = 0, total = size || 0;
    for (;;) {
      let r;
      if (gv) { u.searchParams.set('range', `${pos}-${pos + CHUNK - 1}`); r = await fetch(u.href, { credentials: 'omit' }); }
      else r = await fetch(url, { credentials: 'include', headers: { Range: `bytes=${pos}-${pos + CHUNK - 1}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cr = r.headers.get('content-range'); if (cr) { const m = /\/(\d+)$/.exec(cr); if (m) total = +m[1]; }
      const buf = new Uint8Array(await r.arrayBuffer()); if (!buf.length) break;
      parts.push(buf); pos += buf.length; onBytes(pos, total);
      if (r.status === 200 && !cr && !gv) break; if (total && pos >= total) break; if (buf.length < CHUNK) break;
    }
    return parts;
  }
  async function loadMerge(src, onProgress) {
    const got = [0, 0], tot = [src.video.size || 0, src.audio.size || 0];
    const upd = () => { const d = got[0] + got[1], t = tot[0] + tot[1]; onProgress(t ? Math.round((d / t) * 90) : 0, `${(d / 1048576).toFixed(1)} MB`); };
    const files = await Promise.all([src.video, src.audio].map((s, i) => fetchChunked(s.url, s.size, (p, t) => { got[i] = p; if (t) tot[i] = t; upd(); })));
    onProgress(95, 'building preview…');
    return fmp4Merge(files);
  }

  async function load(c, onProgress = () => {}) {
    const hit = cache.get(c.candidateId);
    if (hit) return hit;
    let blob;
    if (c.source.type === 'hls') blob = await loadHls(c.source.url, onProgress);
    else if (c.source.type === 'merge') blob = await loadMerge(c.source, onProgress);
    else throw new Error(`${c.source.type} preview not supported`);
    const res = { url: URL.createObjectURL(blob), bytes: blob.size };
    cache.set(c.candidateId, res);
    return res;
  }

  window.DVOPreview = { load, cache };
})();
