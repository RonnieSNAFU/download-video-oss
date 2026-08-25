// Download Video OSS: core content script (detection only; downloads run in background/offscreen).
// Builds the candidate list for this tab:
//   1. site plugins (core/registry.js, sites/*.js): exact metadata, preferred
//   2. network-sniffed media URLs from background.js (HLS / DASH / direct files)
(() => {
  let candidates = [];
  const enrichCache = new Map(); // stream url -> last good enrich() result
  const manual = [];             // user-added URLs: [{url, kind, addedAt}]
  let linkScan = false;          // opt-in per site (chrome.storage.local.linkScan[hostname])
  let linkCount = 0;             // how many video links the page has (shown even when scanning is off)

  const LINK_RE = /\.(mp4|webm|m4v|mov|m3u8)(\?[^#]*)?(#.*)?$/i;
  async function loadLinkScan() {
    try { const { linkScan: m } = await chrome.storage.local.get('linkScan'); linkScan = !!(m && m[location.hostname]); } catch { linkScan = false; }
  }
  // plain <a href> to video files (imageboards, directory listings, forums): opt-in because a page can have hundreds
  function scanLinks() {
    const out = [];
    const seenUrl = new Set();
    const anchors = [...document.querySelectorAll('a[href]')];
    for (const a of anchors) {
      const href = a.href;
      if (!href || seenUrl.has(href) || !/^https?:/.test(href) || !LINK_RE.test(href)) continue;
      seenUrl.add(href);
      const kind = /\.m3u8/i.test(href) ? 'hls' : 'file';
      let id;
      try { id = new URL(href).pathname.split('/').filter(Boolean).pop().replace(/\.\w+$/, '') || 'video'; } catch { id = 'video'; }
      // thumbnail: an <img> inside the link, else an <img> nearby whose src shares the file's id
      let thumb = null;
      const img = a.querySelector('img');
      if (img && img.src) thumb = img.src;
      else {
        const box = a.closest('article, li, .post, .postContainer, .file, figure, td, div') || a.parentElement;
        const near = box && [...box.querySelectorAll('img')].find((i) => i.src && i.src.includes(id.slice(0, 10)));
        if (near) thumb = near.src;
      }
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      out.push({ href, kind, id, thumb, title: text && text.length > 3 && text.length < 200 ? text : id, el: a });
    }
    return out;
  }
  let picked = null;             // user-picked player: { el, rec, at, streams:Set<url> }

  const abs = (u) => { try { return u ? new URL(u, location.href).href : null; } catch { return null; } };

  // Grab a frame from a <video> that has data (works for blob:/MSE players; cross-origin
  // sources taint the canvas and throw -> fall back to poster / og:image).
  function captureFrame(v) {
    try {
      if (!v || v.readyState < 2 || !v.videoWidth) return null;
      const c = document.createElement('canvas');
      const w = 240, h = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * w));
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.7);
    } catch { return null; }
  }

  function pageMeta() {
    try {
      const og = (p) => { const m = document.querySelector(`meta[property="${p}"]`); return m && m.content; };
      const videos = (window.DVO.dom ? window.DVO.dom.allVideos() : [...document.querySelectorAll('video')]);
      const playing = videos.find((v) => !v.paused && v.readyState >= 2 && v.videoWidth) || videos.find((v) => v.readyState >= 2 && v.videoWidth) || videos[0];
      // page-level thumbnail only when it is unambiguous (a single player): otherwise it would be wrong
      const single = videos.length === 1;
      return {
        title: og('og:title') || document.title || location.hostname,
        thumbnail: (single && (captureFrame(playing) || abs(playing && playing.poster))) || abs(og('og:image')),
        duration: single && playing && Number.isFinite(playing.duration) && playing.duration > 0 ? playing.duration : null,
      };
    } catch (e) {
      console.warn('[DVO] pageMeta failed', e);
      return { title: document.title || location.hostname, thumbnail: null, duration: null };
    }
  }

  function labelFor(url, kind) {
    try {
      const u = new URL(url);
      return `${kind.toUpperCase()} · ${u.hostname} · ${u.pathname.split('/').filter(Boolean).pop() || u.hostname}`;
    } catch { return `${kind.toUpperCase()} · ${url.slice(0, 60)}`; }
  }

  async function detect() {
    await loadLinkScan();
    const list = [];
    try {
      for (const p of DVO.detect()) {
        if (!p || !p.source || !p.source.type) continue;
        list.push({ ...p, id: String(p.id || 'video'), title: String(p.title || document.title || 'video'), thumbnail: abs(p.thumbnail), candidateId: `plugin:${p.site}:${p.id}`, label: p.site });
      }
    } catch (e) { console.warn('[DVO] plugin stage failed', e); }

    let sniffed = [];
    try { sniffed = (await chrome.runtime.sendMessage({ type: 'getSniffed' })) || []; } catch {}
    const meta = pageMeta();
    const seen = new Set(list.map((c) => c.source.url));
    const rank = { hls: 0, file: 1, dash: 2 };
    const net = [];
    // Adaptive (separate video/audio) streams: group by playback id (one group per video; feeds preload
    // several), newest group first; within a group pair the best mp4 video-only with the best mp4 audio-only.
    const gvAll = sniffed.filter((s) => s.kind === 'gv');
    const groups = new Map();
    for (const s of gvAll) { const k = s.gid || 'x'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    const ordered = [...groups.values()].sort((a, b) => Math.max(...b.map((s) => s.time)) - Math.max(...a.map((s) => s.time)));
    ordered.forEach((gv, gi) => {
      const yt = window.DVO.adaptive;
      const ym = gi === 0 && yt ? yt.meta() : null;
      const base = ym && ym.videoId
        ? { title: ym.title, thumbnail: ym.thumbnail, duration: ym.duration, pageUrl: `https://www.youtube.com/watch?v=${ym.videoId}`, vid: ym.videoId }
        : gi === 0
          ? { ...meta, pageUrl: location.href, vid: 'yt' }
          : { title: `Earlier video #${gi}`, thumbnail: null, duration: null, pageUrl: location.href, vid: `yt${gi}` };
      const info = (s) => ({ ...((yt && yt.ITAGS[s.itag]) || {}), mime: s.mime || '' });
      const mp4 = (s) => /mp4/i.test(s.mime || '') || info(s).c === 'mp4';
      const vids = gv.filter((s) => /^video/i.test(s.mime) && mp4(s) && !info(s).p).sort((a, b) => (info(b).h || 0) - (info(a).h || 0));
      const auds = gv.filter((s) => /^audio/i.test(s.mime) && mp4(s)).sort((a, b) => (info(b).kbps || 0) - (info(a).kbps || 0));
      const prog = gv.filter((s) => info(s).p);
      const push = (id, suffix, source, cid) => list.push({
        id: `${base.vid}-${id}`, title: `${base.title} (${suffix})`, thumbnail: base.thumbnail, duration: base.duration,
        pageUrl: base.pageUrl, site: 'adaptive', source, candidateId: `gv:${cid}`, label: 'adaptive',
      });
      for (const s of prog) push(s.itag, `${info(s).h}p`, { type: 'file', url: s.url, ext: 'mp4' }, s.url);
      if (vids.length && auds.length) {
        const a = auds[0];
        for (const v of vids) {
          const q = info(v).h ? `${info(v).h}p${info(v).fps || ''}` : `itag ${v.itag}`;
          push(`${v.itag}+${a.itag}`, q, { type: 'merge', video: { url: v.url, size: v.size }, audio: { url: a.url, size: a.size } }, `${v.url}+${a.url}`);
        }
      } else {
        for (const s of [...vids, ...auds]) {
          const kind = /^video/i.test(s.mime) ? `${info(s).h || '?'}p video only` : 'audio only';
          push(s.itag, kind, { type: 'file', url: s.url, ext: /webm/i.test(s.mime) ? 'webm' : 'mp4' }, s.url);
        }
      }
      for (const s of gv) seen.add(s.url);
    });
    for (const s of sniffed) {
      if (s.kind === 'gv' || seen.has(s.url)) continue;
      seen.add(s.url);
      let extra = DVO.enrich(s);
      if (extra && extra.skip) continue;
      // generic fallback: match the stream to a player element on the page (shadow-DOM aware)
      if (!extra && window.DVO.dom) {
        const g = window.DVO.dom.enrich(s);
        if (g) extra = g.exact
          ? { thumbnail: g.thumbnail, duration: g.duration, title: g.title, pageUrl: g.pageUrl }
          : { thumbnail: g.thumbnail, duration: g.duration };
        if (extra) extra = Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null));
        if (extra && !Object.keys(extra).length) extra = null;
      }
      // remember the best metadata ever seen for this stream (players leave the DOM on scroll)
      if (extra) {
        const prev = enrichCache.get(s.url) || {};
        extra = Object.fromEntries(Object.entries({ ...prev, ...extra }).map(([k, v]) => [k, v ?? prev[k] ?? null]));
        enrichCache.set(s.url, extra);
      } else if (enrichCache.has(s.url)) extra = enrichCache.get(s.url);
      let id;
      try { id = new URL(s.url).pathname.split('/').filter(Boolean).pop().replace(/\.\w+$/, '') || 'video'; } catch { id = 'video'; }
      net.push({
        id, ...meta, pageUrl: location.href, site: 'network', size: s.size || 0,
        ...(extra || {}),
        thumbnail: abs(extra && 'thumbnail' in extra ? extra.thumbnail : meta.thumbnail),
        source: { type: s.kind, url: s.url },
        candidateId: `net:${s.url}`, label: labelFor(s.url, s.kind),
      });
    }
    // One video, several playlists: a player fetches the master and then each rendition it decides to
    // play (video 480, audio 128, ...). They live in the same directory and all describe the same
    // video, so keep the master and drop the renditions.
    const RENDITION = /(_|-)(\d{2,4}|audio|video|a\d+|v\d+)(_|-|\.|$)|\d{3,4}p|\d{3,4}x\d{3,4}/i;
    const dirOf = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/[^/]*$/, ''); } catch { return u; } };
    const fileOf = (u) => { try { return new URL(u).pathname.split('/').pop() || ''; } catch { return u; } };
    const byDir = new Map();
    for (const c of net) {
      if (c.source.type !== 'hls') continue;
      const k = dirOf(c.source.url);
      if (!byDir.has(k)) byDir.set(k, []);
      byDir.get(k).push(c);
    }
    const dropped = new Set();
    for (const group of byDir.values()) {
      if (group.length < 2) continue;
      const masters = group.filter((c) => !RENDITION.test(fileOf(c.source.url)));
      if (!masters.length) continue; // every name looks like a rendition: no way to tell, keep them
      for (const c of group) if (!masters.includes(c)) dropped.add(c);
    }
    // Renditions of a byte-range stream are plain media files (CMAF_480.mp4, ...), so they arrive as
    // files rather than playlists. When a master playlist covers the same directory they are pieces
    // of it, usually video-only or audio-only, not separate videos.
    const masterDirs = new Set(net.filter((c) => c.source.type === 'hls' && !dropped.has(c)).map((c) => dirOf(c.source.url)));
    for (const c of net) {
      if (c.source.type === 'hls' || !masterDirs.has(dirOf(c.source.url))) continue;
      if (RENDITION.test(fileOf(c.source.url))) dropped.add(c);
    }
    for (let i = net.length - 1; i >= 0; i--) if (dropped.has(net[i])) net.splice(i, 1);

    // a DASH manifest next to an HLS playlist for the same asset is a duplicate we can't download anyway
    const assetKey = (u) => { try { const x = new URL(u); return x.origin + x.pathname.split('/').slice(0, 3).join('/'); } catch { return u; } };
    const hlsKeys = new Set(net.filter((c) => c.source.type === 'hls').map((c) => assetKey(c.source.url)));
    for (let i = net.length - 1; i >= 0; i--) if (net[i].source.type === 'dash' && hlsKeys.has(assetKey(net[i].source.url))) net.splice(i, 1);
    // user-picked player: a direct <video src> becomes a candidate; streams that started after the
    // pick while that player was playing are attributed to it (thumbnail/title/duration)
    if (picked && picked.el && picked.el.isConnected) {
      const rec = window.DVO.dom ? window.DVO.dom.describe(picked.el) : null;
      const direct = [picked.el.currentSrc, picked.el.src, ...[...picked.el.querySelectorAll('source')].map((s) => s.src)].find((u) => u && !u.startsWith('blob:'));
      const pmeta = { title: (rec && rec.title) || meta.title, thumbnail: (rec && (rec.poster || rec.frame)) || null, duration: (rec && rec.duration) || null, pageUrl: (rec && rec.link) || location.href };
      if (direct && !seen.has(direct)) {
        seen.add(direct);
        const kind = /\.m3u8(\?|#|$)/i.test(direct) ? 'hls' : /\.mpd(\?|#|$)/i.test(direct) ? 'dash' : 'file';
        net.unshift({ id: 'picked', ...pmeta, site: 'picked', source: { type: kind, url: direct }, candidateId: `picked:${direct}`, label: 'picked' });
      }
      for (const s of sniffed) {
        if (s.kind === 'gv' || s.time < picked.at) continue;
        picked.streams.add(s.url);
      }
      for (const c of net) {
        if (picked.streams.has(c.source.url) && c.site === 'network') Object.assign(c, pmeta, { site: 'picked', label: 'picked', thumbnail: abs(pmeta.thumbnail) });
      }
    }
    // linked video files (opt-in per site)
    const links = scanLinks();
    linkCount = links.length;
    if (linkScan) {
      for (const l of links) {
        if (seen.has(l.href)) continue;
        seen.add(l.href);
        let extra = DVO.enrich({ url: l.href, kind: l.kind });
        if (extra && extra.skip) continue;
        net.push({
          id: l.id, title: l.title, thumbnail: abs(l.thumb), duration: null, pageUrl: location.href, site: 'link',
          ...(extra || {}),
          thumbnail: abs((extra && extra.thumbnail) || l.thumb),
          source: { type: l.kind, url: l.href }, candidateId: `link:${l.href}`, label: 'link',
        });
      }
    }
    // whatever the page's player has already played, which needs no request of its own
    const cap = await askCapture('status');
    for (const g of (cap && cap.groups) || []) {
      if (!g.bytes || g.bytes < 300000) continue;
      const vids = window.DVO.dom ? window.DVO.dom.allVideos() : [];
      const el = vids.find((v) => v.currentSrc === g.url) || (vids.length === 1 ? vids[0] : null);
      const rec = el && window.DVO.dom ? window.DVO.dom.describe(el) : null;
      net.push({
        id: `capture-${g.id}`,
        title: (rec && rec.title) || meta.title,
        thumbnail: abs((rec && (rec.frame || rec.poster)) || meta.thumbnail),
        duration: el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null,
        pageUrl: location.href, site: 'captured',
        source: { type: 'captured', groupId: g.id, bytes: g.bytes },
        candidateId: `cap:${g.id}`, label: 'captured',
      });
    }
    // user-added URLs
    for (const m of manual) {
      if (seen.has(m.url)) continue;
      seen.add(m.url);
      net.push({ id: m.id, ...meta, pageUrl: location.href, site: 'manual', thumbnail: abs(meta.thumbnail), source: { type: m.kind, url: m.url }, candidateId: `manual:${m.url}`, label: 'manual' });
    }
    net.sort((a, b) => rank[a.source.type] - rank[b.source.type]);
    const ids = new Set();
    const next = [...list, ...net].filter((c) => !ids.has(c.id) && ids.add(c.id));

    const changed = JSON.stringify(next.map((c) => c.candidateId)) !== JSON.stringify(candidates.map((c) => c.candidateId));
    candidates = next;
    if (changed) chrome.runtime.sendMessage({ type: 'detected', video: candidates.length ? candidates[0] : null, count: candidates.length }).catch(() => {});
  }

  function highlightCandidate(candidateId) {
    const c = candidates.find((x) => x.candidateId === candidateId);
    if (!c || !window.DVO.dom) return false;
    if (c.site === 'link') {
      const a = [...document.querySelectorAll('a[href]')].find((x) => x.href === c.source.url);
      return window.DVO.dom.highlight(a && (a.querySelector('img') || a));
    }
    const urls = [c.source.url, c.source.video && c.source.video.url, c.thumbnail].filter(Boolean);
    let el = null;
    for (const u of urls) { el = window.DVO.dom.elementFor(u); if (el) break; }
    if (!el) {
      // last resort: a single player on the page, or the one currently playing
      const vids = window.DVO.dom.allVideos();
      el = vids.length === 1 ? vids[0] : null;
    }
    return window.DVO.dom.highlight(el);
  }

  // ---------- pick-on-page mode ----------
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y), guard = 0;
    while (el && el.shadowRoot && guard++ < 10) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }
  function nearestVideo(el) {
    let e = el, hops = 0;
    const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
    while (e && hops++ < 15) {
      if (e.tagName === 'VIDEO') return e;
      const v = e.querySelector && (e.querySelector('video') || (e.shadowRoot && e.shadowRoot.querySelector('video')));
      if (v) return v;
      e = parentOf(e);
    }
    return null;
  }
  function startPick() {
    if (startPick.active) return;
    startPick.active = true;

    const banner = document.createElement('div');
    const say = (text, color) => {
      banner.textContent = text;
      Object.assign(banner.style, {
        position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483647,
        background: color || '#e11d74', color: '#fff', font: '600 14px system-ui', padding: '10px 16px',
        borderRadius: '10px', boxShadow: '0 4px 16px rgba(0,0,0,.4)', pointerEvents: 'none',
      });
      if (!banner.isConnected) document.documentElement.appendChild(banner);
    };
    say('Download Video OSS: click the video you want (Esc cancels)');

    const prevCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';

    // point -> player: the box test first (sites stack transparent overlays over their players),
    // then a walk up from whatever is under the cursor
    const videoAt = (x, y) => {
      const byBox = window.DVO.dom && window.DVO.dom.videoAtPoint(x, y);
      return byBox || nearestVideo(deepElementFromPoint(x, y));
    };

    let hover = null;
    const onMove = (e) => {
      const v = videoAt(e.clientX, e.clientY);
      if (v !== hover) {
        hover = v;
        // never scroll while hovering: the page would move under the cursor and the pick would chase it
        if (v && window.DVO.dom) window.DVO.dom.highlight(v, 1200, { scroll: false });
      }
    };

    const EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick'];
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };

    const finish = () => {
      startPick.active = false;
      document.documentElement.style.cursor = prevCursor;
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('keydown', onKey, true);
      for (const t of EVENTS) window.removeEventListener(t, onDown, true);
    };

    // Pick on pointerdown and swallow the rest of the gesture: many sites navigate on mousedown or
    // mouseup, which would tear down the page before the pick registers.
    const onDown = (e) => {
      swallow(e);
      if (e.type !== 'pointerdown' && e.type !== 'mousedown') return;
      const v = videoAt(e.clientX, e.clientY);
      finish();
      if (!v) { say('No video found there. Try again from the extension.', '#b45309'); setTimeout(() => banner.remove(), 2600); return; }
      picked = { el: v, at: Date.now(), streams: new Set() };
      // a player that already has data requested its stream a moment ago: look back a little
      if (v.readyState >= 2) picked.at -= 20000;
      if (window.DVO.dom) window.DVO.dom.highlight(v, 2500);
      if (v.paused && v.play) v.play().catch(() => {});
      detect().catch(() => {});
      say('Picked. Open the extension to download or clip it.', '#15803d');
      setTimeout(() => banner.remove(), 3200);
    };

    const onKey = (e) => { if (e.key === 'Escape') { finish(); banner.remove(); } };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    for (const t of EVENTS) window.addEventListener(t, onDown, true);
  }

  function addManualUrl(url) {
    let u;
    try { u = new URL(url); } catch { return { ok: false, error: 'not a valid URL' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'only http(s) URLs' };
    const kind = /\.m3u8(\?|#|$)/i.test(url) || /m3u8/i.test(u.pathname) ? 'hls' : /\.mpd(\?|#|$)/i.test(url) ? 'dash' : 'file';
    if (!manual.some((m) => m.url === url)) manual.push({ url, kind, id: `manual-${manual.length + 1}`, addedAt: Date.now() });
    return { ok: true, kind };
  }

  async function diagnostics() {
    let sniffed = [];
    try { sniffed = (await chrome.runtime.sendMessage({ type: 'getSniffed' })) || []; } catch {}
    const vids = (window.DVO.dom ? window.DVO.dom.allVideos() : [...document.querySelectorAll('video')]).map((v) => ({
      src: v.src, currentSrc: v.currentSrc, poster: v.poster, duration: v.duration, readyState: v.readyState, paused: v.paused,
      size: `${v.videoWidth}x${v.videoHeight}`, inShadow: !!(v.getRootNode && v.getRootNode() !== document),
      sources: [...v.querySelectorAll('source')].map((s) => s.src),
    }));
    const og = {};
    for (const m of document.querySelectorAll('meta[property^="og:"]')) og[m.getAttribute('property')] = m.content;
    const scriptsWithMedia = [...document.scripts].filter((s) => /m3u8|\.mp4|mpd|videoUrl|video_url|playerResponse|mediaDefinitions|flashvars|sources/i.test(s.textContent || '')).length;
    return {
      version: chrome.runtime.getManifest().version, ua: navigator.userAgent, url: location.href, title: document.title, og,
      plugins: window.DVO.sites.map((s) => ({ name: s.name, matches: (() => { try { return s.match(location); } catch { return 'err'; } })() })),
      candidates: candidates.map((c) => ({ id: c.id, site: c.site, type: c.source.type, url: c.source.url || c.source.video?.url, title: c.title, hasThumb: !!c.thumbnail, duration: c.duration })),
      sniffed, videos: vids, iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean).slice(0, 20),
      scriptsWithMediaHints: scriptsWithMedia, picked: !!picked, manual,
    };
  }

  // Some hosts only serve a stream to the page that asked for it. Fetching from the page and saving
  // with a link keeps the request identical to the player's own.
  async function pageDownload({ jobId, url, filename }) {
    const report = (patch) => chrome.runtime.sendMessage({ type: 'progress', jobId, ...patch }).catch(() => {});
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return false;
    const total = +r.headers.get('content-length') || 0;
    (async () => {
      try {
        const reader = r.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          report({ state: 'running', done: got, total, percent: total ? Math.round((got / total) * 99) : 0 });
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(chunks, { type: r.headers.get('content-type') || 'video/mp4' }));
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 120000);
        report({ state: 'done', percent: 100, bytes: got });
      } catch (e) {
        report({ state: 'error', error: e.message });
      }
    })();
    return true;
  }

  // ---------- player capture (capture.js runs in the page's world) ----------
  let captureRid = 0;
  function askCapture(op, id) {
    return new Promise((resolve) => {
      const rid = ++captureRid;
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.__dvo !== 'res' || e.data.rid !== rid) return;
        window.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ __dvo: 'req', op, id, rid }, '*');
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, 800);
    });
  }

  async function captureSave({ jobId, groupId, filename }) {
    const report = (p) => chrome.runtime.sendMessage({ type: 'progress', jobId, ...p }).catch(() => {});
    if (!window.webmRemux || !window.fmp4Merge) {
      const r = await chrome.runtime.sendMessage({ type: 'injectPreview' });
      if (!r || !r.ok) throw new Error('could not load the assembler');
    }
    report({ state: 'running', percent: 25 });
    const res = await askCapture('take', groupId);
    if (!res || res.error) throw new Error((res && res.error) || 'capture unavailable');
    const streams = (res.streams || []).map((s) => ({ mime: s.mime, bytes: new Uint8Array(s.buffer) }));
    if (!streams.length) throw new Error('nothing captured yet: play the video first');
    report({ state: 'remuxing', percent: 70 });
    await new Promise((r) => setTimeout(r, 30));
    const webm = streams.some((s) => /webm/i.test(s.mime));
    const blob = webm ? window.webmRemux(streams.map((s) => s.bytes)) : window.fmp4Merge(streams.map((s) => [s.bytes]));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${filename}.${webm ? 'webm' : 'mp4'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
    report({ state: 'done', percent: 100, bytes: blob.size });
    return { ok: true };
  }

  let sniffTimer = 0;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'sniffed') { // a new media request: recount after things settle
      clearTimeout(sniffTimer);
      sniffTimer = setTimeout(() => detect().catch(() => {}), 700);
      return false;
    }
    if (msg.type === 'captureSave') {
      captureSave(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'pageDownload') {
      pageDownload(msg).then((ok) => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (msg.type === 'pick') { startPick(); sendResponse({ ok: true }); return false; }
    if (msg.type === 'addUrl') {
      const r = addManualUrl(msg.url);
      if (r.ok) detect().catch(() => {});
      sendResponse(r);
      return false;
    }
    if (msg.type === 'diagnostics') {
      diagnostics().then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
      return true;
    }
    if (msg.type === 'openClip') {
      const c = candidates.find((x) => x.candidateId === msg.candidateId);
      if (!c || !window.DVO.clipModal) { sendResponse({ ok: false }); return false; }
      try { window.DVO.clipModal.open(c, candidates); sendResponse({ ok: true }); } catch (e) { console.warn('[DVO] clip modal failed', e); sendResponse({ ok: false, error: e.message }); }
      return false;
    }
    if (msg.type === 'getTime') {
      const c = candidates.find((x) => x.candidateId === msg.candidateId);
      let el = null;
      if (c && window.DVO.dom) for (const u of [c.source.url, c.source.video && c.source.video.url, c.thumbnail].filter(Boolean)) { el = window.DVO.dom.elementFor(u); if (el) break; }
      if (!el && window.DVO.dom) { const vids = window.DVO.dom.allVideos(); el = vids.length === 1 ? vids[0] : null; }
      sendResponse(el ? { time: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : null } : null);
      return false;
    }
    if (msg.type === 'highlight') {
      sendResponse({ ok: highlightCandidate(msg.candidateId) });
      return false;
    }
    if (msg.type === 'getState') {
      // always answer, even if detection throws: the popup must never hang
      Promise.race([detect(), new Promise((r) => setTimeout(r, 4000))])
        .catch((e) => console.warn('[DVO] detect failed', e))
        .finally(() => sendResponse({ candidates, linkScan, linkCount, host: location.hostname }));
      return true; // async
    }
    return false;
  });

  detect().catch((e) => console.warn('[DVO] detect failed', e));
  let last = location.href;
  setInterval(() => {
    if (location.href !== last) { last = location.href; setTimeout(() => detect().catch(() => {}), 800); }
  }, 1000);
})();
