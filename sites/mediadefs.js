// Players that expose a "mediaDefinitions" list: one HLS master per quality.
(() => {
  const HOST = /(^|\.)(pornhub(premium)?\.(com|net|org)|modelhub\.com)$/;

  function mediaDefinitions() {
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t || t.indexOf('mediaDefinitions') < 0) continue;
      const i = t.indexOf('"mediaDefinitions"');
      const start = t.indexOf('[', i);
      if (i < 0 || start < 0) continue;
      let depth = 0, inStr = false, esc = false;
      for (let k = start; k < t.length; k++) {
        const ch = t[k];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, k + 1)); } catch { break; } } }
      }
    }
    return null;
  }

  function flashvar(name) {
    for (const s of document.scripts) {
      const m = new RegExp(`"${name}"\\s*:\\s*"?([^",}]+)"?`).exec(s.textContent || '');
      if (m) return m[1];
    }
    return null;
  }

  DVO.register({
    name: 'mediadefs',
    match: (loc) => HOST.test(loc.hostname) && /view_video|\/embed\//.test(loc.pathname + loc.search),
    detect() {
      const defs = mediaDefinitions();
      if (!Array.isArray(defs)) return null;
      const vk = new URLSearchParams(location.search).get('viewkey') || (/\/embed\/([\w]+)/.exec(location.pathname) || [])[1] || 'video';
      const og = (p) => { const m = document.querySelector(`meta[property="${p}"]`); return m && m.content; };
      const title = (document.querySelector('h1.title, .title-container h1, h1') || {}).textContent || og('og:title') || document.title;
      const thumb = flashvar('image_url') || og('og:image');
      const dur = +flashvar('video_duration') || null;
      const out = [];
      for (const d of defs) {
        if (!d || !d.videoUrl || typeof d.videoUrl !== 'string') continue;
        const quality = Array.isArray(d.quality) ? null : String(d.quality || d.height || '');
        if (!quality) continue; // the "all qualities" entry (quality: [..]) is an API link, not a stream
        out.push({
          id: `${vk}-${quality}p`,
          title: `${title.trim()} (${quality}p)`,
          thumbnail: thumb ? thumb.replace(/\\\//g, '/') : null,
          duration: dur,
          pageUrl: `https://www.pornhub.com/view_video.php?viewkey=${vk}`,
          source: { type: d.format === 'hls' ? 'hls' : 'file', url: d.videoUrl.replace(/\\\//g, '/') },
        });
      }
      out.sort((a, b) => parseInt(b.id.split('-').pop()) - parseInt(a.id.split('-').pop()));
      return out.length ? out : null;
    },
    // the player also requests the chosen quality's playlists; those duplicate the plugin entries
    enrich: (s) => (/phncdn\.com\/hls\//.test(s.url) ? { skip: true } : null),
  });
})();
