// Download Video OSS: background service worker
//  * sniffs media requests per tab (observe-only webRequest) so MSE/blob: players work
//  * owns download jobs (many per tab): direct files via chrome.downloads, HLS/merge via the offscreen engine
//  * keeps the toolbar badge in sync, answers popup/content-script queries

const SEGMENT_RE = /\.(ts|m4s|aac|vtt|jpg|png)(\?|#|$)|\/seg(ment)?[-_]?\d+|chunk[-_]?\d+/i;
const MAX_PER_TAB = 80;
const MAX_ACTIVE_PER_TAB = 2;

const sniffed = new Map();      // tabId -> [{url, kind, ct, size, time, ...}]
const rejected = new Map();     // tabId -> [{url, ct, size, why}]  (for diagnostics)
const pageDetected = new Map(); // tabId -> bool
const jobs = new Map();         // jobId -> { jobId, tabId, candidateId, title, state, percent, done, total, error, downloadId, video }
let jobSeq = 0;

const GV_RE = /^https:\/\/[^/]*\.googlevideo\.com\/videoplayback/i;

// Adaptive streams: every range request is a different URL; normalise to the stream URL and tag itag/mime.
function normalizeRanged(url, ct) {
  const u = new URL(url);
  if (u.searchParams.has('sabr') || /vnd\.yt\.media/i.test(ct) || u.searchParams.get('ump')) return null; // server-ABR, not a plain stream
  for (const k of ['range', 'rn', 'rbuf', 'ump', 'srfvp', 'alr']) u.searchParams.delete(k);
  return {
    url: u.href, itag: +u.searchParams.get('itag') || 0, mime: u.searchParams.get('mime') || ct,
    size: +u.searchParams.get('clen') || 0, live: u.searchParams.has('sq'),
    gid: u.searchParams.get('id') || '', // same for all streams of one playback, differs per video
  };
}

function kindOf(url, ct) {
  if (GV_RE.test(url)) return 'gv';
  if (/\.m3u8(\?|#|$)/i.test(url) || /mpegurl/i.test(ct)) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(url) || /dash\+xml/i.test(ct)) return 'dash';
  if (/\.(mp4|m4v|webm|mov)(\?|#|$)/i.test(url) || /^video\//i.test(ct)) return 'file';
  return null;
}

function reject(tabId, url, ct, size, why) {
  let list = rejected.get(tabId);
  if (!list) rejected.set(tabId, (list = []));
  if (list.some((e) => e.url === url)) return;
  list.push({ url, ct, size, why });
  if (list.length > 60) list.shift();
}

function remember(tabId, url, ct, size) {
  if (tabId < 0) return;
  const kind = kindOf(url, ct);
  if (!kind) {
    // keep a trace of media-ish things we ignored, so diagnostics can show them
    if (/^(audio|video)\//i.test(ct) || (/octet-stream/i.test(ct) && size > 500_000)) reject(tabId, url, ct, size, 'unrecognised media');
    return;
  }
  let extra = {};
  if (kind === 'gv') {
    const gv = normalizeRanged(url, ct);
    if (!gv) return reject(tabId, url, ct, size, 'server-ABR stream');
    if (gv.live) return reject(tabId, url, ct, size, 'live stream');
    url = gv.url; size = gv.size; extra = { itag: gv.itag, mime: gv.mime, gid: gv.gid };
  } else {
    if (kind === 'file' && SEGMENT_RE.test(url)) return reject(tabId, url, ct, size, 'looks like a segment');
    if (kind === 'file' && size && size < 200_000) return reject(tabId, url, ct, size, 'too small');
  }
  let list = sniffed.get(tabId);
  if (!list) sniffed.set(tabId, (list = []));
  const bare = url.split('#')[0];
  const existing = list.find((e) => e.url === bare);
  if (existing) { existing.time = Date.now(); return; }
  list.push({ url: bare, kind, ct, size: size || 0, time: Date.now(), ...extra });
  if (list.length > MAX_PER_TAB) list.shift();
  updateBadge(tabId);
  chrome.tabs.sendMessage(tabId, { type: 'sniffed' }).catch(() => {}); // ask the page to re-count
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    try {
      const h = (n) => (d.responseHeaders || []).find((x) => x.name.toLowerCase() === n);
      // partial responses: Content-Range carries the full size, Content-Length only the chunk
      const cr = /\/(\d+)\s*$/.exec((h('content-range') || {}).value || '');
      const size = cr ? +cr[1] : +((h('content-length') || {}).value || 0);
      remember(d.tabId, d.url, (h('content-type') || {}).value || '', size);
    } catch (e) { console.warn('[DVO] sniff failed', e); }
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders'],
);

const resetTab = (d) => {
  if (d.frameId === 0) { sniffed.delete(d.tabId); rejected.delete(d.tabId); pageDetected.delete(d.tabId); updateBadge(d.tabId); }
};
chrome.webNavigation.onCommitted.addListener(resetTab);
// NOTE: no reset on SPA (history-state) navigation: feeds preload the next videos before you scroll to
// them, so clearing there would drop the current video's streams. Entries age out via MAX_PER_TAB.
chrome.tabs.onRemoved.addListener((tabId) => {
  sniffed.delete(tabId); rejected.delete(tabId); pageDetected.delete(tabId);
  for (const [id, j] of jobs) if (j.tabId === tabId && !isActive(j)) jobs.delete(id);
});

// ---------- jobs ----------
const isActive = (j) => j.state === 'running' || j.state === 'remuxing' || j.state === 'encoding' || j.state === 'queued';
const tabJobs = (tabId) => [...jobs.values()].filter((j) => j.tabId === tabId);

function updateBadge(tabId) {
  const active = tabJobs(tabId).filter(isActive);
  let text;
  if (active.length) {
    const running = active.filter((j) => j.state !== 'queued');
    const pct = running.length ? Math.round(running.reduce((n, j) => n + (j.percent || 0), 0) / running.length) : 0;
    text = active.length > 1 ? `${active.length}↓` : `${pct}%`;
  } else {
    const recent = tabJobs(tabId);
    if (recent.some((j) => j.state === 'error')) text = '!';
    else if (recent.length && recent.every((j) => j.state === 'done')) text = 'OK';
    else {
      // what the popup will list, not how many media requests were seen: one video can be fetched
      // as a master playlist plus several rendition files
      const reported = pageDetected.get(tabId);
      const n = reported === undefined ? (sniffed.get(tabId) || []).length : reported;
      text = n ? String(n) : '';
    }
  }
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#e11d74' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

const publicJobs = (tabId) => tabJobs(tabId).map(({ video, ...j }) => j);
function broadcast(tabId) {
  updateBadge(tabId);
  chrome.runtime.sendMessage({ type: 'jobs', tabId, jobs: publicJobs(tabId) }).catch(() => {});
}

function setJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;
  const wasActive = isActive(job);
  Object.assign(job, patch);
  broadcast(job.tabId);
  if (wasActive && !isActive(job)) { if (job.usesReferer) releaseReferer(job.tabId); pump(job.tabId); }
}

// ---------- Referer for the engine's own requests ----------
// fetch() from an extension page cannot send a cross-origin Referer, and many CDNs refuse segment
// requests without one. A session declarativeNetRequest rule stamps the page URL as Referer (and
// drops the chrome-extension:// Origin) on requests the extension itself initiates. Ref-counted per tab.
const refRules = new Map(); // tabId -> { id, count }
async function acquireReferer(tabId, referer) {
  const id = 100000 + (tabId % 100000);
  const cur = refRules.get(tabId);
  if (cur) { cur.count++; return; }
  refRules.set(tabId, { id, count: 1 });
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [
          { header: 'Referer', operation: 'set', value: referer },
          { header: 'Origin', operation: 'remove' },
        ] },
        condition: { urlFilter: '*', initiatorDomains: [chrome.runtime.id], tabIds: [-1],
          resourceTypes: ['xmlhttprequest', 'media', 'other', 'image', 'script'] },
      }],
    });
  } catch (e) { console.warn('[DVO] referer rule failed', e); }
}
async function releaseReferer(tabId) {
  const cur = refRules.get(tabId);
  if (!cur) return;
  if (--cur.count > 0) return;
  refRules.delete(tabId);
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [cur.id] }); } catch {}
}

// ---------- offscreen engine ----------
let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Assemble HLS segments into an MP4 and hand it to the downloads API',
    }).finally(() => { creating = null; });
  }
  await creating;
}

// ---------- downloads ----------
const fmtT = (s) => { s = Math.round(s * 10) / 10; const m = Math.floor(s / 60); return `${m}m${(s - m * 60).toFixed(1).replace(/\.0$/, '')}s`; };
function safeName(name) {
  const s = Array.from(name || 'video').filter((c) => c.charCodeAt(0) >= 32).join('');
  return s.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 150) || 'video';
}

function enqueue(tabId, videos) {
  for (const video of videos) {
    if (!video || !video.source) continue;
    if (tabJobs(tabId).some((j) => j.candidateId === video.candidateId && isActive(j))) continue; // already active
    const jobId = `${tabId}:${++jobSeq}`;
    const clipTag = video.clip ? ` [${fmtT(video.clip.start)}-${fmtT(video.clip.end)}]` : '';
    jobs.set(jobId, { jobId, tabId, candidateId: video.candidateId, title: video.title + clipTag, clip: video.clip || null, state: 'queued', percent: 0, done: 0, total: 0, error: null, downloadId: null, usesReferer: false, bytes: 0, note: null, video });
  }
  broadcast(tabId);
  pump(tabId);
}

function pump(tabId) {
  const active = tabJobs(tabId).filter((j) => j.state === 'running' || j.state === 'remuxing' || j.state === 'encoding').length;
  if (active >= MAX_ACTIVE_PER_TAB) return;
  const next = tabJobs(tabId).find((j) => j.state === 'queued');
  if (next) runJob(next);
}

async function runJob(job) {
  const { tabId, video, jobId } = job;
  setJob(jobId, { state: 'running', percent: 0 });
  try {
    const { type, url } = video.source;
    if (video.clip || type === 'hls' || type === 'merge') {
      if (type === 'dash') throw new Error('DASH streams not supported yet');
      await ensureOffscreen();
      await acquireReferer(tabId, video.pageUrl || url);
      job.usesReferer = true;
      const clipTag = video.clip ? ` ${fmtT(video.clip.start)}-${fmtT(video.clip.end)}` : '';
      // user-chosen name (clip editor) replaces "title [id]"
      const filename = video.filenameBase ? `${safeName(video.filenameBase)}${clipTag}.mp4` : `${safeName(video.title)} [${video.id}]${clipTag}.mp4`;
      const r = await chrome.runtime.sendMessage({ type: 'offscreen:job', jobId, source: video.source, referer: video.pageUrl, filename, clip: video.clip || null });
      if (!r || !r.ok) throw new Error((r && r.error) || 'engine busy');
    } else if (type === 'file') {
      let ext = video.source.ext || 'mp4';
      const m = /\.(mp4|m4v|webm|mov)(\?|#|$)/i.exec(url);
      if (m) ext = m[1].toLowerCase();
      const filename = video.filenameBase ? `${safeName(video.filenameBase)}.${ext}` : `${safeName(video.title)} [${video.id}].${ext}`;
      let downloadId;
      try {
        downloadId = await chrome.downloads.download({ url, filename, saveAs: false, headers: [{ name: 'Referer', value: video.pageUrl }] });
      } catch {
        downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
      }
      setJob(jobId, { downloadId });
    } else {
      throw new Error(`${type.toUpperCase()} streams are not supported yet.`);
    }
  } catch (e) {
    setJob(jobId, { state: 'error', error: e.message });
  }
}

// chrome.downloads progress for direct files
chrome.downloads.onChanged.addListener((delta) => {
  for (const job of jobs.values()) {
    if (job.downloadId !== delta.id) continue;
    if (delta.state) {
      if (delta.state.current === 'complete') setJob(job.jobId, { state: 'done', percent: 100 });
      else if (delta.state.current === 'interrupted') setJob(job.jobId, { state: 'error', error: (delta.error && delta.error.current) || 'interrupted' });
    }
  }
});
setInterval(async () => {
  for (const job of jobs.values()) {
    if (job.state !== 'running' || job.downloadId == null) continue;
    const [d] = await chrome.downloads.search({ id: job.downloadId });
    if (d && d.state === 'in_progress') setJob(job.jobId, { done: d.bytesReceived, total: d.totalBytes, percent: d.totalBytes > 0 ? Math.round((d.bytesReceived / d.totalBytes) * 100) : 0 });
  }
}, 750);

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : msg.tabId;
  try { return handle(msg, tabId, sendResponse); } catch (e) { console.warn('[DVO] message failed', e); sendResponse(null); return false; }
});
function handle(msg, tabId, sendResponse) {
  switch (msg.type) {
    case 'getSniffed':
      sendResponse((sniffed.get(tabId) || []).slice().sort((a, b) => a.time - b.time));
      break;
    case 'getRejected':
      sendResponse(rejected.get(tabId) || []);
      break;
    case 'detected':
      pageDetected.set(tabId, msg.count != null ? msg.count : (msg.video ? 1 : 0));
      updateBadge(tabId);
      break;
    case 'injectPreview': // clip editor needs mux.js + mp4fix + preview loader in the page (isolated world)
      chrome.scripting.executeScript({ target: { tabId }, files: ['mux.min.js', 'mp4fix.js', 'core/preview.js'] })
        .then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    case 'getJobs':
      sendResponse(publicJobs(tabId));
      break;
    case 'clearJobs': // forget finished/failed jobs for this tab
      for (const [id, j] of jobs) if (j.tabId === tabId && !isActive(j)) jobs.delete(id);
      broadcast(tabId);
      sendResponse({ ok: true });
      break;
    case 'download':
      enqueue(tabId, msg.videos || (msg.video ? [msg.video] : []));
      sendResponse({ ok: true });
      break;
    case 'saveBlob': // offscreen engine finished building a file
      chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
        .then((id) => { setJob(msg.jobId, { downloadId: id }); sendResponse({ ok: true }); })
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true; // async response
    case 'progress': { // from offscreen engine
      const p = { state: msg.state, percent: msg.percent, error: msg.error };
      if (msg.done != null) p.done = msg.done;
      if (msg.total != null) p.total = msg.total;
      if (msg.bytes != null) p.bytes = msg.bytes;
      p.note = msg.note || null;
      setJob(msg.jobId, p);
      break;
    }
  }
  return false;
}
