// Imageboards: media is linked directly with a thumbnail that follows a naming convention.
// Supplies thumbnail and post text for both scanned links and streams seen after opening an embed.
(() => {
  const CDN = /^https?:\/\/(i|is\d?)\.4cdn\.org\/([a-z0-9]+)\/(\d+)(s)?\.(webm|mp4|jpg|gif|png)/i;

  function postFor(url) {
    const m = CDN.exec(url);
    if (!m) return {};
    const a = document.querySelector(`a[href*="/${m[2]}/${m[3]}."]`);
    const post = a && a.closest('.post, .postContainer, [id^="p"], article');
    if (!post) return {};
    const fileName = (post.querySelector('.fileText a, .file-info a') || {}).textContent || '';
    const msg = (post.querySelector('.postMessage, blockquote') || {}).textContent || '';
    const id = post.id || '';
    const num = /\d+/.exec(id);
    return {
      title: [fileName.trim(), msg.trim().replace(/\s+/g, ' ').slice(0, 100)].filter(Boolean).join(' : '),
      pageUrl: num ? `${location.origin}${location.pathname.replace(/#.*$/, '')}#p${num[0]}` : location.href,
    };
  }

  DVO.register({
    name: 'imageboard',
    match: (loc) => /(^|\.)(4chan|4channel)\.org$/.test(loc.hostname),
    detect: () => null,
    enrich(s) {
      const m = CDN.exec(s.url);
      if (!m || m[4]) return null; // not a media file (or it's the thumbnail itself)
      const p = postFor(s.url);
      return {
        id: m[3],
        thumbnail: `https://i.4cdn.org/${m[2]}/${m[3]}s.jpg`,
        title: p.title || `${m[3]}.${m[5]}`,
        pageUrl: p.pageUrl || location.href,
        duration: null,
      };
    },
  });
})();
