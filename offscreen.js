// Download Video OSS: download engine (runs in an extension offscreen document).
// Extension origin + <all_urls> host permission => cross-origin fetches are not CORS-restricted,
// and we have a DOM for URL.createObjectURL. Direct files are handled by chrome.downloads in background.js.
//   hls   -> fetch segments (AES-128 ok, separate audio rendition ok) -> mux.js (TS -> fMP4) or native fMP4 -> mp4fix.js -> progressive MP4
//   merge -> video-only + audio-only fMP4 fetched in ranges -> mp4fix.js merge
// Several jobs may run concurrently (keyed by jobId).
(() => {
  const CONCURRENCY = 6;
  const jobs = new Map(); // jobId -> { cancelled }

  const report = (jobId, patch) => chrome.runtime.sendMessage({ type: 'progress', jobId, ...patch }).catch(() => {});

  async function fetchBuf(url, referer, range = null, tries = 3) {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(url, { credentials: 'include', referrer: referer, referrerPolicy: 'unsafe-url', headers: range ? rangeHeader(range) : undefined });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return applyRange(await r.arrayBuffer(), r.status, range);
      } catch (e) {
        if (i >= tries - 1) throw e;
        await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
      }
    }
  }
  const fetchText = async (url, ref) => new TextDecoder().decode(await fetchBuf(url, ref));

  function parseAttrs(s) {
    const out = {};
    for (const m of s.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }

  // "#EXT-X-BYTERANGE:<length>[@<offset>]": the segment is a slice of the resource named on the next
  // line. Without this, a playlist whose segments all point at one file downloads that whole file
  // once per segment.
  function parseByteRange(v, prevEnd) {
    if (!v) return null;
    const m = /^\s*(\d+)(?:@(\d+))?/.exec(String(v).replace(/"/g, ''));
    if (!m) return null;
    return { offset: m[2] !== undefined ? +m[2] : (prevEnd || 0), length: +m[1] };
  }
  const rangeHeader = (r) => ({ Range: `bytes=${r.offset}-${r.offset + r.length - 1}` });
  // a server may ignore Range and send the whole resource: cut the slice ourselves in that case
  const applyRange = (buf, status, r) => (r && status === 200 && buf.byteLength > r.length
    ? buf.slice(r.offset, r.offset + r.length) : buf);

  function parseMediaPlaylist(text, baseUrl) {
    const segs = [];
    let map = null, mapRange = null, key = null, seq = 0, pendingRange = null;
    const ends = new Map(); // resource -> where the previous slice of it ended
    for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = +line.split(':')[1] || 0;
      else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(line.slice(11));
        map = new URL(a.URI, baseUrl).href;
        mapRange = parseByteRange(a.BYTERANGE, 0);
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) pendingRange = line.slice(17).trim();
      else if (line.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(line.slice(11));
        if (a.METHOD === 'NONE') key = null;
        else if (a.METHOD === 'AES-128') key = { uri: new URL(a.URI, baseUrl).href, iv: a.IV || null };
        else throw new Error(`unsupported encryption: ${a.METHOD} (DRM)`);
      } else if (!line.startsWith('#')) {
        const url = new URL(line, baseUrl).href;
        const range = parseByteRange(pendingRange, ends.get(url) || 0);
        if (range) ends.set(url, range.offset + range.length);
        pendingRange = null;
        segs.push({ url, range, key, seq: seq++, map, mapRange, mapKey: map ? `${map}|${mapRange ? mapRange.offset + '-' + mapRange.length : ''}` : null });
      }
    }
    return segs;
  }

  // returns { uri, audioUri }: audioUri when the chosen variant references a separate audio rendition
  function pickVariant(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const audioGroups = new Map(); // GROUP-ID -> uri (first/default)
    for (const l of lines) {
      if (!l.startsWith('#EXT-X-MEDIA:')) continue;
      const a = parseAttrs(l.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI && (!audioGroups.has(a['GROUP-ID']) || a.DEFAULT === 'YES')) audioGroups.set(a['GROUP-ID'], new URL(a.URI, baseUrl).href);
    }
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = parseAttrs(lines[i].slice(18));
      const bw = +(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || 0);
      const next = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
      if (next && (!best || bw > best.bw)) best = { bw, uri: new URL(next.trim(), baseUrl).href, audioUri: a.AUDIO ? audioGroups.get(a.AUDIO) || null : null };
    }
    if (!best) throw new Error('no variants in master playlist');
    return best;
  }

  const keyCache = new Map();
  async function decryptSeg(buf, seg, referer) {
    if (!seg.key) return buf;
    let ck = keyCache.get(seg.key.uri);
    if (!ck) {
      ck = await crypto.subtle.importKey('raw', await fetchBuf(seg.key.uri, referer), { name: 'AES-CBC' }, false, ['decrypt']);
      keyCache.set(seg.key.uri, ck);
    }
    const iv = new Uint8Array(16);
    if (seg.key.iv) {
      const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else new DataView(iv.buffer).setUint32(12, seg.seq);
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, buf);
  }

  function remuxTs(bufs) {
    const parts = [];
    const t = new muxjs.mp4.Transmuxer({ remux: true });
    let gotInit = false;
    t.on('data', (seg) => { if (!gotInit) { parts.push(seg.initSegment); gotInit = true; } parts.push(seg.data); });
    for (const b of bufs) { t.push(new Uint8Array(b)); t.flush(); }
    if (!gotInit) throw new Error('remux produced no output');
    return fmp4ToProgressive(parts);
  }

  // downloads one media playlist; returns { parts, isFmp4 } (parts = init+segments for fMP4, raw TS buffers otherwise)
  async function fetchMediaPlaylist(jobId, playlistUrl, referer, progress) {
    const state = jobs.get(jobId);
    const text = await fetchText(playlistUrl, referer);
    const segs = parseMediaPlaylist(text, playlistUrl);
    if (!segs.length) throw new Error('empty playlist');
    const bufs = new Array(segs.length);
    let done = 0, next = 0;
    const worker = async () => {
      while (next < segs.length) {
        if (state.cancelled) throw new Error('cancelled');
        const i = next++;
        bufs[i] = await decryptSeg(await fetchBuf(segs[i].url, referer, segs[i].range), segs[i], referer);
        done++;
        progress(done, segs.length);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const isFmp4 = !!segs[0].map || new Uint8Array(bufs[0])[0] !== 0x47;
    if (!isFmp4) return { parts: bufs, isFmp4 };
    const parts = [];
    let lastMap = null;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].map && segs[i].mapKey !== lastMap) { parts.push(new Uint8Array(await fetchBuf(segs[i].map, referer, segs[i].mapRange))); lastMap = segs[i].mapKey; }
      parts.push(new Uint8Array(bufs[i]));
    }
    return { parts, isFmp4 };
  }

  async function downloadHls(jobId, url, referer) {
    const text = await fetchText(url, referer);
    let videoUrl = url, audioUrl = null;
    if (/#EXT-X-STREAM-INF/.test(text)) { const v = pickVariant(text, url); videoUrl = v.uri; audioUrl = v.audioUri; }

    const prog = [0, 0], tot = [0, 0];
    const upd = (i) => (d, t) => {
      prog[i] = d; tot[i] = t;
      const D = prog[0] + prog[1], T = tot[0] + tot[1];
      report(jobId, { state: 'running', done: D, total: T, percent: T ? Math.round((D / T) * 95) : 0 });
    };
    const [video, audio] = await Promise.all([
      fetchMediaPlaylist(jobId, videoUrl, referer, upd(0)),
      audioUrl ? fetchMediaPlaylist(jobId, audioUrl, referer, upd(1)) : null,
    ]);

    report(jobId, { state: 'remuxing', percent: 97 });
    await new Promise((r) => setTimeout(r, 30));
    if (!video.isFmp4) return remuxTs(video.parts); // TS always carries its own audio
    if (audio && audio.isFmp4) return fmp4Merge([video.parts, audio.parts]);
    return fmp4ToProgressive(video.parts);
  }

  // Large single files: fetch in 10 MB ranges (some CDNs throttle or cut whole-file requests); progress is reported as bytes.
  const CHUNK = 10 * 1024 * 1024;
  async function fetchChunked(url, referer, knownSize, onBytes) {
    const u = new URL(url);
    const isGv = /\.googlevideo\.com$/i.test(u.hostname);
    const parts = [];
    let pos = 0, total = knownSize || 0;
    for (;;) {
      let r;
      if (isGv) { u.searchParams.set('range', `${pos}-${pos + CHUNK - 1}`); r = await fetch(u.href, { credentials: 'omit' }); }
      else r = await fetch(url, { credentials: 'include', referrer: referer, referrerPolicy: 'unsafe-url', headers: { Range: `bytes=${pos}-${pos + CHUNK - 1}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cr = r.headers.get('content-range');
      if (cr) { const m = /\/(\d+)$/.exec(cr); if (m) total = +m[1]; }
      const buf = new Uint8Array(await r.arrayBuffer());
      if (!buf.length) break;
      parts.push(buf); pos += buf.length; onBytes(pos, total);
      if (r.status === 200 && !cr && !isGv) break; // server ignored Range: got whole file
      if (total && pos >= total) break;
      if (buf.length < CHUNK) break;
    }
    return parts;
  }

  async function downloadMerge(jobId, source, referer) {
    const streams = [source.video, source.audio];
    const got = [0, 0], tot = [source.video.size || 0, source.audio.size || 0];
    const upd = () => {
      const d = got[0] + got[1], t = tot[0] + tot[1];
      report(jobId, { state: 'running', done: d, total: t || d + 1, percent: t ? Math.round((d / t) * 95) : 0 });
    };
    const files = await Promise.all(streams.map((st, i) => fetchChunked(st.url, referer, st.size, (p, t) => { got[i] = p; if (t) tot[i] = t; upd(); })));
    report(jobId, { state: 'remuxing', percent: 97 });
    await new Promise((r) => setTimeout(r, 30));
    return fmp4Merge(files);
  }

  // whole source as bytes (for clipping / converting)
  async function sourceBytes(jobId, source, referer) {
    if (source.type === 'merge') return new Uint8Array(await (await downloadMerge(jobId, source, referer)).arrayBuffer());
    if (source.type === 'hls') return new Uint8Array(await (await downloadHls(jobId, source.url, referer)).arrayBuffer());
    if (source.type === 'file') {
      const parts = await fetchChunked(source.url, referer, 0, (d, t) => report(jobId, { state: 'running', done: d, total: t, percent: t ? Math.round((d / t) * 60) : 0 }));
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    }
    throw new Error(`${source.type.toUpperCase()} streams not supported yet`);
  }

  async function waitClipEngine() {
    for (let i = 0; i < 100 && !window.DVOClip; i++) await new Promise((r) => setTimeout(r, 100));
    if (!window.DVOClip) throw new Error('clip engine failed to load');
    return window.DVOClip;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'offscreen:job') return false;
    const { jobId, source, referer, filename, clip } = msg;
    if (jobs.has(jobId)) { sendResponse({ ok: false, error: 'already running' }); return false; }
    jobs.set(jobId, { cancelled: false });
    (async () => {
      try {
        let blob, outName = filename;
        if (clip) {
          const engine = await waitClipEngine();
          const bytes = await sourceBytes(jobId, source, referer);
          const inputName = source.type === 'file' ? (/\.(\w{2,4})(\?|#|$)/.exec(source.url) || [, 'mp4'])[1] : 'mp4';
          report(jobId, { state: 'encoding', percent: 0 });
          const res = await engine.run(bytes, `in.${inputName}`, clip, (p) => report(jobId, { state: 'encoding', percent: p.percent || 0, note: p.phase === 'loading' ? 'loading encoder…' : p.phase === 'decoding' ? (p.note || 'preparing…') : (p.note ? `Encoding ${p.note} · ${p.percent || 0}%` : null) }));
          const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', gif: 'image/gif' };
          blob = new Blob([res.bytes], { type: MIME[res.ext] || `video/${res.ext}` });
          outName = filename.replace(/\.\w+$/, '') + `.${res.ext}`;
        } else {
          if (source.type === 'merge') blob = await downloadMerge(jobId, source, referer);
          else if (source.type === 'file') {
            const parts = await fetchChunked(source.url, referer, source.size || 0,
              (d, t) => report(jobId, { state: 'running', done: d, total: t, percent: t ? Math.round((d / t) * 99) : 0 }));
            blob = new Blob(parts, { type: 'video/mp4' });
          } else blob = await downloadHls(jobId, source.url, referer);
        }
        // chrome.downloads is not available in offscreen documents -> background saves it
        const blobUrl = URL.createObjectURL(blob);
        const r = await chrome.runtime.sendMessage({ type: 'saveBlob', jobId, url: blobUrl, filename: outName });
        if (!r || !r.ok) throw new Error((r && r.error) || 'save failed');
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10 * 60_000);
        report(jobId, { state: 'done', percent: 100, bytes: blob.size });
      } catch (e) {
        console.error('[DVO offscreen]', e);
        report(jobId, { state: 'error', error: e.message });
      } finally {
        jobs.delete(jobId);
      }
    })();
    sendResponse({ ok: true });
    return false;
  });
})();
