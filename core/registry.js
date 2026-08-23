// Site plugin registry. Each site plugin calls DVO.register({...}) with:
//   name:   display name, e.g. 'kvs'
//   match:  (location) => boolean                      : cheap URL test
//   detect: () => VideoInfo | VideoInfo[] | null       : inspect the page; may be called repeatedly
//   enrich: (sniffed) => Partial<VideoInfo> | {skip:true} | null  : optional: per-URL metadata for
//           network-sniffed streams (title/thumbnail/duration/id/pageUrl), or skip to hide duplicates
//
// VideoInfo = {
//   id, title, thumbnail, duration (seconds|null), pageUrl,
//   source: { type: 'hls' | 'file' | 'dash', url }
// }
// Plugins are tried in registration order; all matches are collected (first plugin's results first).
(() => {
  const sites = [];
  window.DVO = {
    sites,
    register(site) { sites.push(site); },
    detect() {
      const out = [];
      for (const site of sites) {
        try {
          if (!site.match(location)) continue;
          const res = site.detect();
          if (!res) continue;
          for (const info of Array.isArray(res) ? res : [res]) out.push({ ...info, site: site.name });
        } catch (e) {
          console.warn(`[DVO] ${site.name} detect failed`, e);
        }
      }
      return out;
    },
    enrich(s) {
      for (const site of sites) {
        if (!site.enrich) continue;
        try {
          if (!site.match(location)) continue;
          const r = site.enrich(s);
          if (r) return r;
        } catch (e) {
          console.warn(`[DVO] ${site.name} enrich failed`, e);
        }
      }
      return null;
    },
  };
})();
