// Generic fallback: any page with an HTML5 <video> pointing at a direct file or an HLS playlist.
// Registered last so site-specific plugins win.
(() => {
  const FILE_RE = /\.(mp4|m4v|webm|mov)(\?|#|$)/i;
  const HLS_RE = /\.m3u8(\?|#|$)/i;

  function candidates() {
    const urls = [];
    for (const v of document.querySelectorAll('video')) {
      if (v.currentSrc) urls.push({ url: v.currentSrc, el: v });
      if (v.src) urls.push({ url: v.src, el: v });
      for (const s of v.querySelectorAll('source[src]')) urls.push({ url: s.src, el: v });
    }
    return urls.filter((c) => c.url && !c.url.startsWith('blob:'));
  }

  function pageTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    return (og && og.content) || document.title || location.hostname;
  }

  function pageThumb(video) {
    if (video && video.poster) return video.poster;
    const og = document.querySelector('meta[property="og:image"]');
    return og ? og.content : null;
  }

  DVO.register({
    name: 'generic',
    match: () => true,
    detect() {
      for (const { url, el } of candidates()) {
        let type = null;
        if (HLS_RE.test(url)) type = 'hls';
        else if (FILE_RE.test(url)) type = 'file';
        if (!type) continue;
        let id;
        try { id = new URL(url).pathname.split('/').filter(Boolean).pop().replace(/\.\w+$/, ''); } catch { id = 'video'; }
        let extra = null;
        try { extra = DVO.enrich({ url, kind: type }); } catch {}
        if (extra && extra.skip) continue;
        const base = {
          id: id || 'video',
          title: pageTitle(),
          thumbnail: pageThumb(el),
          duration: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null,
          pageUrl: location.href,
        };
        for (const k of ['id', 'title', 'thumbnail', 'duration', 'pageUrl']) if (extra && extra[k] != null) base[k] = extra[k];
        return { ...base, source: { type, url } };
      }
      return null;
    },
  });
})();
