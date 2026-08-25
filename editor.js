// Download Video OSS: the clip editor for a file on the user's machine.
//
// This page belongs to the extension, so a blob URL made here can be read by the engine that does
// the cutting and converting. The file itself never leaves the browser.
(() => {
  window.DVO = window.DVO || {};
  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const say = (text, cls) => { status.textContent = text; status.className = 'status' + (cls ? ' ' + cls : ''); };

  chrome.tabs.getCurrent().then((t) => { if (t) window.__dvoTabId = t.id; }).catch(() => {});

  let currentUrl = null;
  function openFile(file) {
    if (!file) return;
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(file);
    say(`Reading ${file.name}…`);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.src = currentUrl;
    const start = (duration) => {
      say('');
      try {
        window.DVO.clipModal.open({
          id: 'file',
          title: file.name.replace(/\.[^.]+$/, ''),
          thumbnail: null,
          duration: duration || null,
          size: file.size,
          pageUrl: location.href,
          site: 'local',
          source: { type: 'file', url: currentUrl, size: file.size, ext: (/\.(\w{2,4})$/.exec(file.name) || [, 'mp4'])[1].toLowerCase() },
          candidateId: `local:${file.name}:${file.size}`,
        });
      } catch (e) { say(`Could not open the editor: ${e.message}`, 'err'); }
    };
    probe.addEventListener('loadedmetadata', () => start(Number.isFinite(probe.duration) ? probe.duration : null), { once: true });
    probe.addEventListener('error', () => start(null), { once: true }); // container the browser cannot play: times can still be typed
  }

  $('pick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => openFile(e.target.files[0]));

  const drop = $('drop');
  for (const ev of ['dragenter', 'dragover']) window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) window.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget) return; drop.classList.remove('over'); });
  window.addEventListener('drop', (e) => { e.preventDefault(); openFile(e.dataTransfer && e.dataTransfer.files[0]); });

  // progress for jobs started from this page
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'jobs' || msg.tabId !== window.__dvoTabId) return;
    const job = (msg.jobs || [])[msg.jobs.length - 1];
    if (!job) return;
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    if (job.state === 'running') say(`Working… ${job.percent || 0}%${job.total ? ` (${mb(job.done)} of ${mb(job.total)})` : ''}`);
    else if (job.state === 'encoding') say(job.note || `Encoding ${job.percent || 0}%`);
    else if (job.state === 'remuxing') say('Building the file…');
    else if (job.state === 'done') say(`Saved${job.bytes ? ` (${mb(job.bytes)})` : ''}`, 'ok');
    else if (job.state === 'error') say(`Failed: ${job.error}`, 'err');
  });
})();
