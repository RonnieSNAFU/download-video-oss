// KVS (Kernel Video Sharing) player, a common off-the-shelf video site engine.
// Port of yt-dlp's GenericIE._extract_kvs / _kvs_get_real_url / _kvs_get_license_token.
(() => {
  function findFlashvars() {
    // page may have already evaluated it into a global (isolated world usually can't see it, but try)
    if (window.flashvars && typeof window.flashvars === 'object' && window.flashvars.video_url) return window.flashvars;
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t || !/var\s+flashvars\s*=/.test(t)) continue;
      const m = /var\s+flashvars\s*=\s*\{([\s\S]*?)\}\s*;/.exec(t);
      if (!m) continue;
      // KVS flashvars are always  key: 'single-quoted string'  pairs: parse without eval (CSP-safe)
      const obj = {};
      for (const kv of m[1].matchAll(/(\w+)\s*:\s*'((?:\\'|[^'])*)'/g)) obj[kv[1]] = kv[2].replace(/\\'/g, "'");
      if (obj.video_url || obj.video_id) return obj;
    }
    return null;
  }

  function licenseToken(licenseCode) {
    licenseCode = licenseCode.replace(/\$/g, '');
    const values = [...licenseCode].map(Number);
    let mod = licenseCode.replace(/0/g, '1');
    const center = Math.floor(mod.length / 2);
    const front = BigInt(mod.slice(0, center + 1));
    const back = BigInt(mod.slice(center));
    let diff = 4n * (front > back ? front - back : back - front);
    mod = String(diff).slice(0, center + 1);
    const out = [];
    [...mod].forEach((ch, index) => {
      for (let offset = 0; offset < 4; offset++) out.push((values[index + offset] + Number(ch)) % 10);
    });
    return out;
  }

  function realUrl(videoUrl, licenseCode) {
    if (!videoUrl.startsWith('function/0/')) return videoUrl;
    const u = new URL(videoUrl.slice('function/0/'.length));
    const token = licenseToken(licenseCode);
    const parts = u.pathname.split('/');
    const H = 32;
    const hash = parts[3].slice(0, H);
    const idx = [...Array(H).keys()];
    let accum = 0;
    for (let src = H - 1; src >= 0; src--) {
      accum += token[src];
      const dest = (src + accum) % H;
      [idx[src], idx[dest]] = [idx[dest], idx[src]];
    }
    parts[3] = idx.map((i) => hash[i]).join('') + parts[3].slice(H);
    u.pathname = parts.join('/');
    return u.href;
  }

  const maybeB64 = (s) => {
    if (!s || /^(https?:)?\/\/|^function\/|^\//.test(s)) return s;
    try { const d = atob(s); return /^(https?:)?\/\/|^function\//.test(d) ? d : s; } catch { return s; }
  };

  function formats(fv) {
    const out = [];
    for (const key of Object.keys(fv)) {
      if (!/^video_(alt_)?url\d*$/.test(key) && key !== 'video_url_hd') continue;
      let url = maybeB64(fv[key]);
      if (!url || url === '1' || !/^(https?:)?\/\/|^function\/|^\//.test(url)) continue;
      url = realUrl(url, fv.license_code || '');
      const label = fv[`${key}_text`] || (key === 'video_url_hd' ? 'HD' : key === 'video_url' ? 'default' : key);
      const height = +((/(\d{3,4})p/.exec(label) || /_(\d{3,4})p?\./.exec(url) || [])[1] || 0);
      out.push({ key, url: new URL(url, location.href).href, label, height });
    }
    out.sort((a, b) => b.height - a.height);
    return out;
  }

  DVO.register({
    name: 'kvs',
    match: () => true, // cheap: detect() bails fast when no flashvars
    detect() {
      const fv = findFlashvars();
      if (!fv) return null;
      const fmts = formats(fv);
      if (!fmts.length) return null;
      const og = (p) => { const m = document.querySelector(`meta[property="${p}"]`); return m && m.content; };
      const thumb = fv.preview_url || fv.preview_url1 || og('og:image');
      const dur = (() => { const v = document.querySelector('video'); return v && v.duration > 0 && Number.isFinite(v.duration) ? v.duration : null; })();
      const title = (og('og:title') || document.title || '').replace(/\s*[-|-]\s*[^-|-]*$/, '').trim() || document.title;
      return fmts.map((f, i) => ({
        id: `${fv.video_id || 'kvs'}${fmts.length > 1 ? `-${f.label}` : ''}`,
        title: fmts.length > 1 ? `${title} (${f.label})` : title,
        thumbnail: thumb ? new URL(thumb, location.href).href : null,
        duration: dur,
        pageUrl: location.href,
        source: { type: 'file', url: f.url },
      }));
    },
  });
})();
