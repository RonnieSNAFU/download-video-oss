// Adaptive-stream sites: metadata from the page's player response plus any directly usable formats.
// Adaptive streams are mostly discovered by the network sniffer (background.js) and paired
// into video+audio "merge" candidates by core/content.js using the itag table exported here.
(() => {
  // itag -> { h: height, fps, c: container, a: audio-only, p: progressive (has audio) }
  const ITAGS = {
    18: { h: 360, c: 'mp4', p: true }, 22: { h: 720, c: 'mp4', p: true },
    160: { h: 144, c: 'mp4' }, 133: { h: 240, c: 'mp4' }, 134: { h: 360, c: 'mp4' }, 135: { h: 480, c: 'mp4' },
    136: { h: 720, c: 'mp4' }, 137: { h: 1080, c: 'mp4' }, 264: { h: 1440, c: 'mp4' }, 266: { h: 2160, c: 'mp4' },
    298: { h: 720, fps: 60, c: 'mp4' }, 299: { h: 1080, fps: 60, c: 'mp4' },
    394: { h: 144, c: 'mp4' }, 395: { h: 240, c: 'mp4' }, 396: { h: 360, c: 'mp4' }, 397: { h: 480, c: 'mp4' },
    398: { h: 720, c: 'mp4' }, 399: { h: 1080, c: 'mp4' }, 400: { h: 1440, c: 'mp4' }, 401: { h: 2160, c: 'mp4' },
    278: { h: 144, c: 'webm' }, 242: { h: 240, c: 'webm' }, 243: { h: 360, c: 'webm' }, 244: { h: 480, c: 'webm' },
    247: { h: 720, c: 'webm' }, 248: { h: 1080, c: 'webm' }, 271: { h: 1440, c: 'webm' }, 313: { h: 2160, c: 'webm' },
    302: { h: 720, fps: 60, c: 'webm' }, 303: { h: 1080, fps: 60, c: 'webm' }, 308: { h: 1440, fps: 60, c: 'webm' }, 315: { h: 2160, fps: 60, c: 'webm' },
    139: { a: true, kbps: 48, c: 'mp4' }, 140: { a: true, kbps: 128, c: 'mp4' }, 141: { a: true, kbps: 256, c: 'mp4' },
    249: { a: true, kbps: 50, c: 'webm' }, 250: { a: true, kbps: 70, c: 'webm' }, 251: { a: true, kbps: 160, c: 'webm' },
  };

  function playerResponse() {
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t) continue;
      const i = t.indexOf('ytInitialPlayerResponse');
      if (i < 0) continue;
      const start = t.indexOf('{', i);
      if (start < 0) continue;
      // brace-match (strings may contain braces, so track quotes)
      let depth = 0, inStr = false, esc = false;
      for (let k = start; k < t.length; k++) {
        const ch = t[k];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, k + 1)); } catch { break; } } }
      }
    }
    return null;
  }

  function meta() {
    const pr = playerResponse();
    const vd = pr && pr.videoDetails;
    const urlId = new URLSearchParams(location.search).get('v') || (/\/(shorts|live|embed)\/([\w-]{11})/.exec(location.pathname) || [])[2];
    if (!vd || (urlId && vd.videoId !== urlId)) {
      // SPA navigation: page script is stale; fall back to DOM
      const og = (p) => { const m = document.querySelector(`meta[property="${p}"]`); return m && m.content; };
      const title = (document.querySelector('h1.ytd-watch-metadata, h1.title') || {}).textContent || og('og:title') || document.title.replace(/ - YouTube$/, '');
      const v = document.querySelector('video');
      return {
        videoId: urlId, title: title.trim(),
        thumbnail: urlId ? `https://i.ytimg.com/vi/${urlId}/hqdefault.jpg` : og('og:image'),
        duration: v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
        pr: null,
      };
    }
    const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
    return {
      videoId: vd.videoId, title: vd.title,
      thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${vd.videoId}/hqdefault.jpg`,
      duration: +vd.lengthSeconds || null,
      pr,
    };
  }

  window.DVO.adaptive = { ITAGS, meta };

  DVO.register({
    name: 'adaptive',
    match: (loc) => /(^|\.)youtube\.com$/.test(loc.hostname) || loc.hostname === 'youtu.be',
    detect() {
      const m = meta();
      if (!m.videoId) return null;
      const out = [];
      const sd = m.pr && m.pr.streamingData;
      if (sd) {
        // progressive formats with a plain url (no cipher) are directly downloadable
        for (const f of sd.formats || []) {
          if (!f.url) continue;
          const q = f.qualityLabel || `${f.height}p`;
          out.push({
            id: `${m.videoId}-${f.itag}`, title: `${m.title} (${q}, direct)`, thumbnail: m.thumbnail, duration: m.duration,
            pageUrl: `https://www.youtube.com/watch?v=${m.videoId}`, source: { type: 'file', url: f.url, ext: 'mp4' },
          });
        }
        // adaptive with plain urls: best mp4 video + best mp4 audio -> merge
        const ad = (sd.adaptiveFormats || []).filter((f) => f.url && /mp4/.test(f.mimeType || ''));
        const vids = ad.filter((f) => /^video/.test(f.mimeType)).sort((a, b) => (b.height - a.height) || (b.bitrate - a.bitrate));
        const auds = ad.filter((f) => /^audio/.test(f.mimeType)).sort((a, b) => b.bitrate - a.bitrate);
        if (vids.length && auds.length) {
          const seenH = new Set();
          for (const v of vids) {
            if (seenH.has(v.height)) continue;
            seenH.add(v.height);
            out.push({
              id: `${m.videoId}-${v.itag}+${auds[0].itag}`, title: `${m.title} (${v.qualityLabel || v.height + 'p'})`,
              thumbnail: m.thumbnail, duration: m.duration, pageUrl: `https://www.youtube.com/watch?v=${m.videoId}`,
              source: { type: 'merge', video: { url: v.url, size: +v.contentLength || 0 }, audio: { url: auds[0].url, size: +auds[0].contentLength || 0 } },
            });
          }
        }
      }
      return out.length ? out : null;
    },
  });
})();
