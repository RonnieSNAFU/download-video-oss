// Microblog feeds: maps sniffed streams back to the post they belong to (stream and poster URLs share a media id).
// The timeline is virtualized (posts leave the DOM as you scroll), so every video's metadata is recorded
// the moment it appears and kept for the life of the page.
(() => {
  const MEDIA_ID = /\/(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)\//;
  const cache = new Map(); // media id -> { poster, duration, text, user, permalink }

  function postFor(el) {
    const art = el && el.closest('article');
    if (!art) return {};
    const text = (art.querySelector('[data-testid="tweetText"]') || {}).textContent || '';
    const userA = art.querySelector('[data-testid="User-Name"] a[href^="/"]');
    const user = userA ? userA.getAttribute('href').replace(/^\//, '') : '';
    const time = art.querySelector('a[href*="/status/"] time');
    const permalink = time && time.parentElement && time.parentElement.href;
    return { text: text.trim(), user, permalink };
  }

  function record(v) {
    const m = MEDIA_ID.exec(v.poster || '');
    if (!m) return;
    const id = m[1];
    const prev = cache.get(id) || {};
    const t = postFor(v);
    cache.set(id, {
      poster: v.poster || prev.poster,
      duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : prev.duration || null,
      text: t.text || prev.text || '',
      user: t.user || prev.user || '',
      permalink: t.permalink || prev.permalink || null,
    });
  }

  function scan(root) {
    const vids = root.querySelectorAll ? root.querySelectorAll('video[poster]') : [];
    for (const v of vids) record(v);
    if (root.matches && root.matches('video[poster]')) record(root);
  }

  function start() {
    scan(document);
    new MutationObserver((muts) => {
      for (const mu of muts) {
        if (mu.type === 'attributes') { if (mu.target.matches && mu.target.matches('video')) record(mu.target); continue; }
        for (const n of mu.addedNodes) if (n.nodeType === 1) scan(n);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['poster'] });
    // durations become known a bit after the element appears
    document.addEventListener('loadedmetadata', (e) => { if (e.target && e.target.tagName === 'VIDEO') record(e.target); }, true);
    setInterval(() => scan(document), 2000);
  }

  DVO.register({
    name: 'microblog',
    match: (loc) => /(^|\.)(x|twitter)\.com$/.test(loc.hostname),
    detect: () => null, // streams come from the sniffer; we only enrich them
    enrich(s) {
      if (!/video\.twimg\.com/.test(s.url)) return null;
      const m = MEDIA_ID.exec(s.url);
      if (!m) return null;
      const id = m[1];
      // variant playlists duplicate the master; keep only the master (no WxH in path)
      if (s.kind === 'hls' && /\/\d{3,4}x\d{3,4}\//.test(s.url)) return { skip: true };
      const live = document.querySelector(`video[poster*="/${id}/"]`);
      if (live) record(live);
      const c = cache.get(id) || {};
      const title = c.text ? `${c.user ? '@' + c.user + ': ' : ''}${c.text.slice(0, 120)}` : (c.user ? `@${c.user} video` : `video ${id}`);
      return { id, title, thumbnail: c.poster || null, duration: c.duration || null, pageUrl: c.permalink || location.href };
    },
  });

  if (/(^|\.)(x|twitter)\.com$/.test(location.hostname)) start();
})();
