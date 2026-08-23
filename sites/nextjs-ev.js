// Next.js sites that ship the stream URL as an obfuscated "ev" payload in __NEXT_DATA__.
//   1. read __NEXT_DATA__ -> props.pageProps.{video, ev}
//   2. decode ev: JSON.parse(atob(ev.d) with each char code shifted down by ev.k)
//   3. ev.videoUrl is an HLS playlist disguised as .jpg; segments are .jpg-named MPEG-TS
(() => {
  function getPageProps() {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try { return JSON.parse(el.textContent).props.pageProps; } catch { return null; }
  }

  function decodeEv(ev) {
    const raw = atob(ev.d);
    let out = '';
    for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) - ev.k);
    return JSON.parse(out);
  }

  DVO.register({
    name: 'nextjs-ev',
    match: (loc) => /(^|\.)rou\.video$/.test(loc.hostname) && /^\/v\/[a-z0-9]+/.test(loc.pathname),
    detect() {
      const props = getPageProps();
      const v = props && props.video;
      // SSR data must belong to the page we're actually on (client-side nav can leave it stale)
      if (!props || !props.ev || !v || !location.pathname.endsWith(v.id)) return null;
      const { videoUrl } = decodeEv(props.ev);
      if (!videoUrl) return null;
      return {
        id: v.id,
        title: v.name || v.nameZh || v.id,
        thumbnail: v.coverImageUrl || null,
        duration: v.duration || null,
        pageUrl: location.origin + location.pathname,
        source: { type: 'hls', url: videoUrl },
      };
    },
  });
})();
