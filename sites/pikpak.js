// PikPak shares: every file in the folder is listed straight from the page's own data, so the whole
// folder shows up without opening anything.
//
// The playable link for a file is only handed out by their API, to requests carrying the token the
// page itself obtained. The page stores that token when you open any video, and it is accepted for
// every file in the share for a few minutes, so resolving links reuses it instead of asking for a
// new one.
(() => {
  const CLIENT = 'YUMx5nI8ZU8Ap8pm'; // the web app's client id, also the suffix of its token key
  const API = 'https://api-drive.mypikpak.com/drive/v1/share/file_info';
  const isShare = (loc) => /(^|\.)mypikpak\.com$/i.test(loc.hostname) && /^\/s\//.test(loc.pathname);

  // Nuxt serialises its state as a flat array where values point at other entries by index.
  function nuxtState() {
    const el = document.getElementById('__NUXT_DATA__');
    if (!el) return null;
    const arr = JSON.parse(el.textContent);
    const TAGS = new Set(['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'EmptyRef', 'EmptyShallowRef', 'NuxtError', 'Error']);
    const memo = new Map();
    const res = (i) => {
      if (typeof i !== 'number') return i;
      if (i < 0) return null;
      if (memo.has(i)) return memo.get(i);
      const v = arr[i];
      if (Array.isArray(v)) {
        if (typeof v[0] === 'string' && TAGS.has(v[0])) { const o = v.length > 1 ? res(v[1]) : null; memo.set(i, o); return o; }
        const o = []; memo.set(i, o);
        for (const x of v) o.push(res(x));
        return o;
      }
      if (v && typeof v === 'object') {
        const o = {}; memo.set(i, o);
        for (const [k, x] of Object.entries(v)) o[k] = res(x);
        return o;
      }
      memo.set(i, v);
      return v;
    };
    return res(0);
  }

  function shareContents() {
    const root = nuxtState();
    if (!root) return { files: [], passToken: null };
    const files = [];
    const seen = new Set();
    let passToken = null;
    const walk = (o, d = 0) => {
      if (d > 40 || !o || typeof o !== 'object') return;
      if (o.kind === 'drive#file' && o.id && !seen.has(o.id)) { seen.add(o.id); files.push(o); }
      if (!passToken && typeof o.pass_code_token === 'string' && o.pass_code_token) passToken = o.pass_code_token;
      for (const x of Array.isArray(o) ? o : Object.values(o)) walk(x, d + 1);
    };
    walk(root);
    return { files, passToken };
  }

  const isVideo = (f) => /^video\//i.test(f.mime_type || '') || /\.(mp4|mkv|webm|mov|m4v|avi|flv|ts)$/i.test(f.name || '');

  DVO.register({
    name: 'pikpak',
    match: isShare,
    detect() {
      const { files, passToken } = shareContents();
      const shareId = location.pathname.split('/')[2];
      if (!shareId || !passToken) return null;
      const out = files.filter(isVideo).map((f) => ({
        id: f.id,
        title: (f.name || f.id).replace(/\.[^.]+$/, ''),
        thumbnail: f.thumbnail_link || null,
        duration: +((f.params && f.params.duration) || 0) || null,
        size: +f.size || 0,
        pageUrl: location.href,
        // no link yet: it is asked for when the download starts
        source: { type: 'file', url: null, ext: ((/\.(\w{2,4})$/.exec(f.name || '') || [])[1] || 'mp4').toLowerCase(),
          resolve: { plugin: 'pikpak', shareId, fileId: f.id, passToken } },
      }));
      return out.length ? out : null;
    },
    // the player's own downloads of the same files would only duplicate the entries above
    enrich: (s) => (/\.mypikpak\.com\/download\//i.test(s.url) ? { skip: true } : null),
    async resolve(r) {
      let stored = {};
      try { stored = JSON.parse(localStorage.getItem('captcha_' + CLIENT) || '{}'); } catch {}
      const device = localStorage.getItem('deviceid');
      if (!device || !stored.captcha_token) throw new Error('Open any video on this page once, then download again');
      const u = new URL(API);
      u.searchParams.set('share_id', r.shareId);
      u.searchParams.set('file_id', r.fileId);
      u.searchParams.set('pass_code_token', r.passToken);
      const res = await fetch(u, { headers: { 'x-client-id': CLIENT, 'x-device-id': device, 'x-captcha-token': stored.captcha_token, 'content-type': 'application/json' } });
      let j = {};
      try { j = await res.json(); } catch {}
      if (j.error === 'captcha_invalid' || res.status === 401) {
        // the page's current token is for something else, or expired (they last about five minutes)
        throw new Error('Open any video on this page once, then download again within a few minutes');
      }
      if (!res.ok) throw new Error(j.error_description || `HTTP ${res.status}`);
      const fi = j.file_info || {};
      const medias = (fi.medias || []).filter((m) => m.link && m.link.url);
      const pick = medias.find((m) => m.is_origin) || medias.find((m) => m.is_default) || medias[0];
      const url = (pick && pick.link.url) || fi.web_content_link;
      if (!url) throw new Error('PikPak returned no link for this file');
      return { url };
    },
  });
})();
