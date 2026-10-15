// Generic fallback: any page with an HTML5 <video> playing a real (non-blob) URL.
// Registered last so site-specific plugins win.
//
// A URL is accepted when it looks like media by name (.mp4, .m3u8, ...) or when the browser has
// already loaded media from it. The second case matters: many hosts serve files from URLs with no
// extension at all (/download?fid=...), and those used to be found only with "Pick on page".
(() => {
  const FILE_RE = /\.(mp4|m4v|webm|mov|mkv)(\?|#|$)/i;
  const HLS_RE = /\.m3u8(\?|#|$)/i;
  const DASH_RE = /\.mpd(\?|#|$)/i;

  const videos = () => (window.DVO.dom ? window.DVO.dom.allVideos() : [...document.querySelectorAll('video')]);

  function candidates() {
    const out = [];
    for (const v of videos()) {
      const urls = [v.currentSrc, v.src, ...[...v.querySelectorAll('source[src]')].map((s) => s.src)];
      for (const url of urls) {
        if (!url || !/^https?:/i.test(url)) continue; // blob: players are handled by the sniffer and capture
        out.push({ url, el: v });
      }
    }
    return out;
  }

  function typeOf(url, el) {
    if (HLS_RE.test(url)) return 'hls';
    if (DASH_RE.test(url)) return null;
    if (FILE_RE.test(url)) return 'file';
    // no telling extension: trust it if the browser has actually loaded media from this exact URL
    if (el.currentSrc === url && el.readyState >= 1 && (el.videoWidth > 0 || el.duration > 0)) return 'file';
    return null;
  }

  function pageTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    return (og && og.content) || document.title || location.hostname;
  }

  DVO.register({
    name: 'generic',
    match: () => true,
    detect() {
      const found = [];
      const seen = new Set();
      for (const { url, el } of candidates()) {
        if (seen.has(url)) continue;
        const type = typeOf(url, el);
        if (!type) continue;
        seen.add(url);
        let id;
        try { id = new URL(url).pathname.split('/').filter(Boolean).pop().replace(/\.\w+$/, '') || 'video'; } catch { id = 'video'; }
        let extra = null;
        try { extra = DVO.enrich({ url, kind: type }); } catch {}
        if (extra && extra.skip) continue;
        // the player's own surroundings say more than the page title on listing pages
        const rec = window.DVO.dom ? window.DVO.dom.describe(el) : null;
        const og = document.querySelector('meta[property="og:image"]');
        const base = {
          id,
          title: (rec && rec.title) || pageTitle(),
          thumbnail: el.poster || (rec && (rec.poster || rec.frame)) || (og && og.content) || null,
          duration: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null,
          pageUrl: location.href,
        };
        for (const k of ['id', 'title', 'thumbnail', 'duration', 'pageUrl']) if (extra && extra[k] != null) base[k] = extra[k];
        found.push({ ...base, source: { type, url } });
      }
      return found.length ? found : null;
    },
  });
})();
