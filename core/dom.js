// Download Video OSS: generic, site-agnostic DOM intelligence.
//  * finds every <video> on the page, including inside (open) shadow roots
//  * keeps a cache of each player's metadata (poster, duration, captured frame, title, link,
//    and the "tokens" of every URL-ish attribute on the element and its ancestors)
//  * matches a sniffed stream URL to a player by shared tokens (media ids, filenames, hashes)
// Everything is defensive: any failure degrades to "less metadata", never to "no list".
(() => {
  const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
  const abs = (u) => safe(() => (u ? new URL(u, location.href).href : null));

  // ---------- deep DOM walk (shadow roots) ----------
  function* walk(root, depth = 0) {
    if (!root || depth > 40) return;
    const nodes = safe(() => root.querySelectorAll('*'), []);
    for (const el of nodes) {
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot, depth + 1);
    }
  }
  function allVideos() {
    const out = [];
    for (const el of walk(document)) if (el.tagName === 'VIDEO') out.push(el);
    return out;
  }
  // parent that crosses shadow boundaries
  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;

  // ---------- tokens ----------
  const STOP = new Set(['https', 'http', 'www', 'video', 'videos', 'media', 'static', 'cdn', 'assets', 'content', 'embed', 'player',
    'playlist', 'index', 'master', 'manifest', 'hls', 'dash', 'm3u8', 'mpd', 'mp4', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif',
    'thumb', 'thumbnail', 'preview', 'poster', 'image', 'images', 'img', 'pu', 'pl', 'img', 'v', 'vid', 'file', 'files', 'stream', 'streams']);
  function tokensOf(str) {
    const out = new Set();
    if (!str || typeof str !== 'string') return out;
    for (const t of str.split(/[^A-Za-z0-9_-]+/)) {
      if (t.length < 6 || t.length > 80 || STOP.has(t.toLowerCase())) continue;
      if (/^\d{1,5}$/.test(t)) continue;
      out.add(t);
    }
    return out;
  }
  function urlTokens(url) {
    const u = safe(() => new URL(url));
    if (!u) return tokensOf(url);
    const out = tokensOf(decodeURIComponent(u.pathname));
    // ids frequently live in query params too (id=, v=, media=)
    for (const [k, v] of u.searchParams) if (/id|media|video|v$|key|token/i.test(k)) for (const t of tokensOf(v)) out.add(t);
    return out;
  }

  // ---------- per-player metadata ----------
  const cache = new Map(); // key -> rec
  const keys = new WeakMap();
  let nextKey = 1;
  const keyOf = (el) => { let k = keys.get(el); if (!k) { k = nextKey++; keys.set(el, k); } return k; };

  function captureFrame(v) {
    return safe(() => {
      if (!v || v.readyState < 2 || !v.videoWidth) return null;
      const c = document.createElement('canvas');
      const w = 240, h = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * w));
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.7);
    });
  }

  const ATTR_URLISH = /^(src|href|poster|data-[\w-]*(src|url|poster|id|video|media|thumb)[\w-]*|content-href|permalink|post-id|id)$/i;
  const ATTR_TITLE = /^(post-title|title|aria-label|data-title|alt|data-caption)$/i;
  // labels that describe the widget, not the content
  const GENERIC_TITLE = /^(video( player)?|player|media( player)?|play(back)?|thumbnail|poster|image|photo|untitled|loading.*|watch|embed(ded)?( video)?|html5 video( player)?|video thumbnail)$/i;

  function describe(v) {
    const rec = cache.get(keyOf(v)) || { key: keyOf(v) };
    rec.el = v;
    const tokens = new Set(rec.tokens || []);
    let poster = null, title = null, titleScore = 0, link = null, container = null;
    let el = v, hops = 0;
    while (el && hops < 12) {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      for (const a of safe(() => [...el.attributes], [])) {
        if (ATTR_URLISH.test(a.name) || /https?:\/\//.test(a.value)) for (const t of urlTokens(a.value)) tokens.add(t);
        if (!poster && /poster|thumb|preview|cover/i.test(a.name) && /^(https?:)?\/\/|^\//.test(a.value)) poster = abs(a.value);
        if (ATTR_TITLE.test(a.name) && a.value.trim().length > 3 && a.value.length < 300 && !GENERIC_TITLE.test(a.value.trim())) {
          // post/data titles on ancestors beat aria-labels on the player itself
          const score = /^(post-title|data-title|data-caption)$/i.test(a.name) ? 3 : /^title$/i.test(a.name) ? 2 : 1;
          if (score > titleScore) { title = a.value.trim(); titleScore = score; }
        }
        if (!link && /^(permalink|content-href|data-permalink|data-href)$/i.test(a.name) && /^(https?:)?\/\/|^\//.test(a.value)) link = abs(a.value);
      }
      if (!link && tag === 'a' && el.href) link = el.href;
      if (!container && /^(article|shreddit-post|li|section)$/.test(tag)) container = el;
      // <source> children of <video>
      if (el === v) for (const s of safe(() => [...v.querySelectorAll('source')], [])) for (const t of urlTokens(s.src)) tokens.add(t);
      el = parentOf(el); hops++;
    }
    for (const u of [v.currentSrc, v.src]) if (u && !u.startsWith('blob:')) for (const t of urlTokens(u)) tokens.add(t);
    if (!poster && v.poster) poster = abs(v.poster);
    if (titleScore < 2 && container) {
      const h = container.querySelector('h1,h2,h3,[slot="title"],[class*="title" i]');
      const txt = h && h.textContent.trim().replace(/\s+/g, ' ');
      if (txt && txt.length > 3 && !GENERIC_TITLE.test(txt)) { title = txt.slice(0, 160); titleScore = 2; }
    }
    if (!link && container) {
      const a = container.querySelector('a[href*="/video"],a[href*="/watch"],a[slot="full-post-link"],a[href]');
      if (a && a.href) link = a.href;
    }
    const frame = captureFrame(v);
    Object.assign(rec, {
      tokens,
      poster: poster || rec.poster || null,
      frame: frame || rec.frame || null,
      duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : rec.duration || null,
      title: title || rec.title || null,
      link: link || rec.link || null,
      playing: !v.paused && !v.ended && v.readyState >= 2,
      seen: Date.now(),
    });
    cache.set(rec.key, rec);
    return rec;
  }

  function refresh() { safe(() => { for (const v of allVideos()) describe(v); }); }

  // ---------- matching ----------
  function match(streamUrl) {
    const want = urlTokens(streamUrl);
    let best = null, bestScore = 0;
    for (const rec of cache.values()) {
      let score = 0;
      for (const t of want) if (rec.tokens.has(t)) score += Math.min(t.length, 24);
      if (score > bestScore) { best = rec; bestScore = score; }
    }
    if (best) return { rec: best, exact: true };
    // fallbacks: the only player on the page, else the one currently playing
    const recs = [...cache.values()].filter((r) => r.el && r.el.isConnected);
    if (recs.length === 1) return { rec: recs[0], exact: false };
    const playing = recs.filter((r) => r.playing).sort((a, b) => b.seen - a.seen);
    if (playing.length === 1) return { rec: playing[0], exact: false };
    return null;
  }

  // Generic enrichment for a sniffed stream. `exact` matches may override everything; loose
  // matches only supply a thumbnail/duration when nothing better is known.
  function enrich(s) {
    return safe(() => {
      refresh();
      const m = match(s.url);
      if (!m) return null;
      const r = m.rec;
      return {
        exact: m.exact,
        thumbnail: r.poster || r.frame || null,
        duration: r.duration || null,
        title: m.exact ? r.title || null : null,
        pageUrl: m.exact ? r.link || null : null,
      };
    });
  }

  // ---------- keep the cache warm ----------
  function start() {
    refresh();
    safe(() => new MutationObserver(() => { clearTimeout(start._t); start._t = setTimeout(refresh, 300); })
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'poster'] }));
    for (const ev of ['loadedmetadata', 'play', 'playing', 'durationchange']) {
      document.addEventListener(ev, (e) => { if (e.target && e.target.tagName === 'VIDEO') safe(() => describe(e.target)); }, true);
    }
    setInterval(refresh, 2500);
  }

  // ---------- highlight ----------
  let hl = null, hlTimer = null;
  function elementFor(streamUrl) {
    refresh();
    const m = match(streamUrl);
    return m && m.rec.el && m.rec.el.isConnected ? m.rec.el : null;
  }
  function highlight(el, ms = 3000) {
    return safe(() => {
      if (!el) return false;
      // outline the visible player box (the <video> or its nearest sized ancestor)
      let box = el, hops = 0;
      while (box && hops < 4 && box.getBoundingClientRect().width < 40) { box = parentOf(box); hops++; }
      if (!box) box = el;
      box.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      if (!hl) {
        hl = document.createElement('div');
        hl.id = 'dvo-highlight';
        Object.assign(hl.style, {
          position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', boxSizing: 'border-box',
          border: '4px solid #e11d74', borderRadius: '10px', boxShadow: '0 0 0 4px rgba(225,29,116,.35), 0 0 24px rgba(225,29,116,.6)',
          transition: 'opacity .4s', opacity: '0',
        });
      }
      if (!hl.isConnected) document.documentElement.appendChild(hl);
      const place = () => { const r = box.getBoundingClientRect(); Object.assign(hl.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` }); };
      place();
      hl.style.opacity = '1';
      clearTimeout(hlTimer);
      const tick = setInterval(place, 50); // follow the element while the page scrolls smoothly
      hlTimer = setTimeout(() => { hl.style.opacity = '0'; clearInterval(tick); setTimeout(() => hl && hl.remove(), 400); }, ms);
      return true;
    }, false);
  }

  window.DVO = window.DVO || {};
  window.DVO.dom = { allVideos, describe, refresh, match, enrich, cache, urlTokens, elementFor, highlight };
  start();
})();
