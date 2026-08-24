const $ = (id) => document.getElementById(id);
let tabId = null;
let candidates = [];
let jobs = [];
const selected = new Set(); // candidateIds
const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

const fmtDur = (s) => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};
const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;
function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
const hint = (t, ms = 4000) => { $('hint').textContent = t; clearTimeout(hint._t); if (ms) hint._t = setTimeout(() => ($('hint').textContent = ''), ms); };

// newest job per candidate
function jobFor(candidateId) {
  const js = jobs.filter((j) => j.candidateId === candidateId);
  return js.length ? js[js.length - 1] : null;
}

function renderList() {
  const list = $('list');
  list.innerHTML = '';
  for (const c of candidates) {
    const job = jobFor(c.candidateId);
    const item = document.createElement('div');
    item.className = 'item' + (selected.has(c.candidateId) ? ' sel' : '') + (job ? ' has-job' : '');
    item.dataset.id = c.candidateId;

    const check = document.createElement('div'); check.className = 'check'; check.textContent = '✓';
    const thumb = document.createElement('div');
    thumb.className = 'thumb' + (c.thumbnail ? '' : ' none');
    if (c.thumbnail) thumb.style.backgroundImage = `url("${c.thumbnail.replace(/"/g, '%22')}")`;
    else thumb.textContent = 'no preview';

    const info = document.createElement('div'); info.className = 'info';
    const t = document.createElement('div'); t.className = 't'; t.textContent = c.title;
    const m = document.createElement('div'); m.className = 'm';
    const tag = document.createElement('span');
    const kind = c.site === 'manual' ? 'manual' : c.site === 'picked' ? 'picked' : c.site === 'link' ? 'link' : c.source.type;
    tag.className = `tag ${kind}`;
    tag.textContent = c.source.type === 'merge' ? 'VIDEO+AUDIO' : kind.toUpperCase();
    m.appendChild(tag);
    m.appendChild(document.createTextNode(
      [c.duration ? fmtDur(c.duration) : null, c.site === 'network' ? hostOf(c.source.url) : c.site, c.id].filter(Boolean).join(' · ')));
    m.title = c.source.url || (c.source.video && c.source.video.url) || '';

    const jbar = document.createElement('div'); jbar.className = 'jbar'; const fill = document.createElement('i'); jbar.appendChild(fill);
    const jst = document.createElement('div'); jst.className = 'jst';
    if (job) {
      fill.style.width = `${job.percent || 0}%`;
      if (job.state === 'queued') jst.textContent = 'Queued…';
      else if (job.state === 'running') jst.textContent = `Downloading ${job.percent || 0}%` + (job.total ? (job.total > 10000 ? ` · ${fmtMB(job.done)} / ${fmtMB(job.total)}` : ` · ${job.done}/${job.total} segments`) : '');
      else if (job.state === 'remuxing') jst.textContent = 'Building MP4…';
      else if (job.state === 'encoding') jst.textContent = job.note || `Encoding clip ${job.percent || 0}%`;
      else if (job.state === 'done') { jst.textContent = `Saved ✓${job.bytes ? ' · ' + fmtBytes(job.bytes) : ''}${job.clip ? ' (clip)' : ''}`; jst.classList.add('ok'); fill.style.width = '100%'; }
      else if (job.state === 'error') { jst.textContent = `Failed: ${job.error}`; jst.classList.add('err'); }
    }
    info.append(t, m, jbar, jst);
    const clipBtn = document.createElement('button');
    clipBtn.className = 'clipbtn';
    clipBtn.textContent = '✂ Clip';
    clipBtn.title = 'Open the clip editor on the page: trim, preview, convert (MP4, WebM, GIF, MP3)';
    clipBtn.disabled = c.source.type === 'dash';
    clipBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'openClip', candidateId: c.candidateId });
        if (r && r.ok) window.close(); else hint('Could not open the clip editor on this page.');
      } catch { hint('Reload the page first, then try again.'); }
    });
    item.append(check, thumb, info, clipBtn);
    item.addEventListener('click', () => {
      if (selected.has(c.candidateId)) selected.delete(c.candidateId);
      else { selected.add(c.candidateId); chrome.tabs.sendMessage(tabId, { type: 'highlight', candidateId: c.candidateId }).catch(() => {}); }
      renderList(); renderButtons();
    });
    list.appendChild(item);
  }
  $('hdr').textContent = candidates.length === 1 ? 'Detected video' : `${candidates.length} sources. Click to select.`;
  $('selall').textContent = selected.size === candidates.length ? 'clear' : 'select all';
}

function renderButtons() {
  const sel = candidates.filter((c) => selected.has(c.candidateId));
  const dl = $('dl');
  const dashOnly = sel.length && sel.every((c) => c.source.type === 'dash');
  dl.disabled = !sel.length || dashOnly;
  dl.textContent = !sel.length ? '⬇ Download (select a video)' : dashOnly ? 'DASH not supported yet' : sel.length === 1 ? '⬇ Download' : `⬇ Download ${sel.length} selected`;
}

let pageHost = '';
function renderLinkRow(state) {
  const row = $('linkrow');
  if (!state || !state.host) { row.style.display = 'none'; return; }
  pageHost = state.host;
  const n = state.linkCount || 0;
  if (!n && !state.linkScan) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  $('linktoggle').checked = !!state.linkScan;
  $('linklabel').textContent = `Scan page links for video files on ${pageHost} (${n} found)`;
}

function render(state) {
  renderLinkRow(state);
  candidates = (state && state.candidates) || [];
  $('empty').hidden = candidates.length > 0;
  $('card').hidden = candidates.length === 0;
  if (!candidates.length) {
    if (state && state.linkCount && !state.linkScan) $('empty').innerHTML = `No playing video detected.<br><br>This page links to <b>${state.linkCount}</b> video file${state.linkCount > 1 ? 's' : ''}. Turn on <b>Scan page links</b> below to list them.`;
    return;
  }
  for (const id of [...selected]) if (!candidates.some((c) => c.candidateId === id)) selected.delete(id);
  if (!selected.size && candidates.length === 1) selected.add(candidates[0].candidateId);
  renderList();
  renderButtons();
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  let state = null;
  try { state = await chrome.tabs.sendMessage(tabId, { type: 'getState' }); }
  catch {
    const url = (tab && tab.url) || '';
    $('empty').innerHTML = /^https?:/.test(url)
      ? 'This tab was loaded before the extension (re)started.<br><br><b>Reload the page</b>, play the video, then reopen this popup.'
      : 'Nothing to download on this page.';
  }
  jobs = (await chrome.runtime.sendMessage({ type: 'getJobs', tabId }).catch(() => null)) || [];
  render(state);
}

$('linktoggle').addEventListener('change', async () => {
  try {
    const { linkScan: m } = await chrome.storage.local.get('linkScan');
    const map = m || {};
    if ($('linktoggle').checked) map[pageHost] = true; else delete map[pageHost];
    await chrome.storage.local.set({ linkScan: map });
  } catch {}
  await refresh();
});

$('selall').addEventListener('click', () => {
  if (selected.size === candidates.length) selected.clear();
  else for (const c of candidates) selected.add(c.candidateId);
  renderList(); renderButtons();
});

$('dl').addEventListener('click', () => {
  const videos = candidates.filter((c) => selected.has(c.candidateId) && c.source.type !== 'dash');
  if (!videos.length) return;
  chrome.runtime.sendMessage({ type: 'download', tabId, videos }).catch(() => {});
  hint(`${videos.length} download${videos.length > 1 ? 's' : ''} started. You can close this popup.`);
});

// ---------- user-assist tools ----------
$('pick').addEventListener('click', async () => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'pick' });
    hint('Click the video on the page (Esc cancels), then open this popup again.', 0);
    window.close(); // the popup must close so you can click the page
  } catch { hint('Reload the page first, then try again.'); }
});

$('addtoggle').addEventListener('click', () => { $('addbox').classList.toggle('open'); $('addurl').focus(); });
async function addUrl() {
  const url = $('addurl').value.trim();
  if (!/^https?:\/\//i.test(url)) { hint('Paste a full http(s) URL.'); return; }
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'addUrl', url });
    if (r && r.ok) { $('addurl').value = ''; $('addbox').classList.remove('open'); hint('Added.'); await refresh(); }
    else hint((r && r.error) || 'Could not add that URL.');
  } catch { hint('Reload the page first, then try again.'); }
}
$('addgo').addEventListener('click', addUrl);
$('addurl').addEventListener('keydown', (e) => { if (e.key === 'Enter') addUrl(); });

$('diag').addEventListener('click', async () => {
  try {
    const d = await chrome.tabs.sendMessage(tabId, { type: 'diagnostics' });
    d.rejected = await chrome.runtime.sendMessage({ type: 'getRejected', tabId }).catch(() => []);
    d.jobs = jobs;
    await navigator.clipboard.writeText(JSON.stringify(d, null, 2));
    hint('Diagnostics copied to the clipboard. Paste them to whoever maintains the extension.');
  } catch { hint('Reload the page first, then try again.'); }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'jobs' && msg.tabId === tabId) { jobs = msg.jobs || []; renderList(); }
  else if (msg.type === 'detected' && sender.tab && sender.tab.id === tabId) refresh();
});

refresh();
