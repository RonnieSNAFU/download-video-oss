// Download Video OSS: in-page clip editor (modal with preview + dual-handle timeline).
// window.DVO.clipModal.open(candidate, tabId)
//   preview: direct files play in our own <video>; streaming sources (HLS / merged streams) mirror and
//   remote-control the page's own player (canvas copy, seek/play on the page element).
(() => {
  const fmtT = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); const sec = s - m * 60; return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1).replace(/\.0$/, '')}`; };
  const parseT = (s) => { s = String(s || '').trim(); if (!s) return NaN; const p = s.split(':').map(Number); if (p.some(Number.isNaN)) return NaN; return p.reduce((a, n) => a * 60 + n, 0); };
  const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const VBPS = {
    mp4:  { 2160: 12e6, 1440: 7e6, 1080: 3.2e6, 720: 1.6e6, 480: 0.9e6, 360: 0.55e6, 240: 0.3e6 },
    webm: { 2160: 14e6, 1440: 8e6, 1080: 3.8e6, 720: 2e6, 480: 1.1e6, 360: 0.65e6, 240: 0.35e6 },
  };
  const QF = { low: 0.55, medium: 1, high: 1.8 };
  function estimateBytes(c, st, height) {
    const dur = Math.max(0, st.end - st.start);
    if (st.quality === 'target' && /^(mp4|webm|mp3|m4a)$/.test(st.format)) return st.targetBytes || 4 * 1048576;
    const audio = st.noAudio ? 0 : 96e3;
    const h = height || (() => { const m = /(\d{3,4})p/.exec(`${c.title} ${c.id}`); return m ? +m[1] : 720; })();
    const near = (tbl) => tbl[[2160, 1440, 1080, 720, 480, 360, 240].find((k) => h >= k) || 240];
    // source bitrate only when it is plausible (sniffed sizes can be a partial range, durations can be wrong)
    const tableBps = near(VBPS.mp4) * 1.3 + 128e3;
    let srcBps = c.size && c.duration ? (c.size * 8) / c.duration : 0;
    if (!(srcBps >= 80e3 && srcBps <= 120e6)) srcBps = tableBps;
    let bps;
    const qf = QF[st.quality] || 1;
    switch (st.format) {
      case 'mp4-copy': bps = srcBps; break;
      case 'mp4': bps = near(VBPS.mp4) * qf + audio; break;
      case 'webm': {
        const eff = st.codec === 'av1' ? 0.45 : st.codec === 'vp9' ? 0.6 : 1;
        bps = (st.codec === 'vp8' ? (st.quality === 'high' ? near(VBPS.webm) * 0.9 : Math.min(near(VBPS.webm) * qf, { low: 0.6e6, medium: 1.2e6 }[st.quality] || 2.5e6)) : near(VBPS.webm) * qf * eff) + audio;
        break;
      }
      case 'gif': bps = { low: 2.5e6, medium: 6e6, high: 12e6, target: 4.5e6 }[st.quality]; break;
      case 'mp3': bps = { low: 128e3, medium: 192e3, high: 320e3 }[st.quality] || 160e3; break;
      case 'm4a': bps = st.quality === 'target' ? 160e3 : (c.size && c.duration ? Math.min(320e3, (c.size * 8) / c.duration * 0.12) : { low: 128e3, medium: 192e3, high: 256e3 }[st.quality] || 192e3); break;
      case 'wav': bps = 48000 * 16 * 2; break;
      default: bps = srcBps;
    }
    return (bps * dur) / 8;
  }

  const CSS = `
    :host { all: initial; }
    .bg { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; font: 13px system-ui, sans-serif; color: #fff; }
    .box { width: min(1180px, 96vw); max-height: 94vh; overflow: auto; background: #111827; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.6); padding: 14px 16px 16px; box-sizing: border-box; display: flex; gap: 16px; }
    .main { flex: 1; min-width: 0; }
    .side { width: 230px; flex: none; border-left: 1px solid #1f2937; padding-left: 14px; display: flex; flex-direction: column; min-height: 0; }
    .side h3 { font: 600 11px system-ui; text-transform: uppercase; letter-spacing: .04em; opacity: .6; margin: 0 0 8px; }
    .side .list { overflow-y: auto; display: flex; flex-direction: column; gap: 6px; max-height: calc(94vh - 70px); padding-right: 2px; }
    .side .list::-webkit-scrollbar { width: 6px; } .side .list::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
    .it { display: flex; gap: 8px; align-items: center; padding: 5px; border-radius: 8px; background: #1f2937; border: 2px solid transparent; cursor: pointer; }
    .it:hover { background: #273244; } .it.cur { border-color: #e11d74; cursor: default; }
    .it .th { width: 72px; height: 40px; flex: none; border-radius: 5px; background: #000 center/cover no-repeat; display: grid; place-items: center; font-size: 9px; color: #9ca3af; }
    .it .tt { font-size: 11px; font-weight: 600; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .it .tm { font: 10px ui-monospace, monospace; opacity: .6; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 760px) { .box { flex-direction: column; } .side { width: auto; border-left: 0; padding-left: 0; border-top: 1px solid #1f2937; padding-top: 10px; } .side .list { max-height: 160px; } }
    .top { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .top h2 { font: 600 15px system-ui; margin: 0; flex: none; }
    .name { flex: 1; min-width: 0; padding: 7px 10px; border-radius: 8px; border: 1px solid #374151; background: #0b1220; color: #fff; font: 600 14px system-ui; }
    .name:focus { outline: 2px solid #e11d74; border-color: transparent; }
    .ext { font: 12px ui-monospace, monospace; opacity: .7; flex: none; }
    .x { background: #374151; border: 0; color: #fff; border-radius: 8px; width: 30px; height: 30px; font-size: 16px; cursor: pointer; }
    /* stage sizes itself to the media: wide videos fill the width, tall/vertical ones are height-capped and centred */
    .stage { position: relative; background: #000; border-radius: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; min-height: 180px; max-height: 58vh; }
    .stage video, .stage canvas, .stage img { display: block; width: auto; height: auto; max-width: 100%; max-height: 58vh; object-fit: contain; }
    .stage.empty { aspect-ratio: 16/9; }
    .stage .note { position: absolute; bottom: 8px; left: 8px; right: 8px; font-size: 11px; background: rgba(0,0,0,.55); padding: 4px 8px; border-radius: 6px; opacity: .9; }
    .ctl { display: flex; align-items: center; gap: 8px; margin: 10px 0 6px; }
    .btn { background: #374151; border: 0; color: #fff; border-radius: 8px; padding: 8px 12px; font: 600 12px system-ui; cursor: pointer; white-space: nowrap; }
    .btn:hover { background: #4b5563; } .btn.p { background: #e11d74; } .btn.p:hover { background: #f0307f; } .btn.go { background: #7c3aed; padding: 10px 16px; font-size: 13px; } .btn.go:hover { background: #8b5cf6; }
    .btn:disabled { opacity: .5; cursor: default; }
    .time { font: 12px ui-monospace, monospace; opacity: .85; min-width: 120px; }
    .tl { position: relative; height: 44px; margin: 6px 4px 14px; user-select: none; touch-action: none; }
    .track { position: absolute; left: 0; right: 0; top: 16px; height: 12px; background: #374151; border-radius: 6px; cursor: pointer; }
    .sel { position: absolute; top: 16px; height: 12px; background: linear-gradient(90deg, #e11d74, #f472b6); border-radius: 6px; opacity: .85; pointer-events: none; }
    .h { position: absolute; top: 6px; width: 18px; height: 32px; margin-left: -9px; background: #fff; border-radius: 6px; box-shadow: 0 1px 6px rgba(0,0,0,.6); cursor: ew-resize; display: grid; place-items: center; font: 700 11px system-ui; color: #111827; z-index: 2; }
    .h:active, .h.drag { background: #f9a8d4; }
    .h.act { outline: 3px solid #f472b6; outline-offset: 1px; }
    .ph.act { background: #f472b6; width: 3px; box-shadow: 0 0 6px #f472b6; }
    .ph { cursor: ew-resize; pointer-events: auto; }
    .kb { font-size: 10px; opacity: .55; margin-top: 4px; }
    .kb b { color: #f472b6; font-weight: 600; }
    .h.s::after { content: '['; } .h.e::after { content: ']'; }
    .ph { position: absolute; top: 10px; width: 2px; height: 24px; margin-left: -1px; background: #fff; opacity: .9; pointer-events: none; z-index: 1; box-shadow: 0 0 4px #000; }
    .lbl { position: absolute; top: -4px; transform: translateX(-50%); font: 10px ui-monospace, monospace; opacity: .8; pointer-events: none; white-space: nowrap; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .row label { opacity: .7; font-size: 12px; }
    input[type=text] { width: 72px; padding: 6px 8px; border-radius: 6px; border: 1px solid #374151; background: #0b1220; color: #fff; font: 12px ui-monospace, monospace; }
    select { padding: 6px; border-radius: 6px; border: 1px solid #374151; background: #0b1220; color: #fff; font-size: 12px; }
    .est { font: 12px ui-monospace, monospace; opacity: .9; margin-left: auto; text-align: right; }
    .est b { color: #f472b6; }
    .hint { font-size: 11px; opacity: .6; margin-top: 8px; }
    .chk { display: flex; align-items: center; gap: 5px; font-size: 12px; opacity: .85; cursor: pointer; }
    .chk input { accent-color: #e11d74; }
    .status { font-size: 12px; margin-top: 8px; min-height: 16px; }
    .status.ok { color: #4ade80; } .status.err { color: #f87171; }
    .tgt { display: none; align-items: center; gap: 6px; }
    .tgt.on { display: flex; }
    .tgt input { width: 52px; }
    .mini { background: #1f2937; color: #d1d5db; border: 0; border-radius: 5px; padding: 5px 7px; font-size: 11px; cursor: pointer; }
    .mini:hover { background: #273244; }
  `;

  let current = null; // { host, close }

  let carry = null; // settings carried over when switching videos inside the editor
  function open(c, all = [c]) {
    close();
    const host = document.createElement('div');
    host.id = 'dvo-clip-modal';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style'); style.textContent = CSS;
    const bg = document.createElement('div'); bg.className = 'bg';
    const outer = document.createElement('div'); outer.className = 'box';
    const box = document.createElement('div'); box.className = 'main';
    outer.appendChild(box);
    bg.appendChild(outer); root.append(style, bg);
    const mk = (tag, cls, props = {}) => { const e = document.createElement(tag); if (cls) e.className = cls; Object.assign(e, props); return e; };

    // ---------- sidebar: the other detected videos ----------
    if (all.length > 1) {
      const side = mk('div', 'side');
      side.appendChild(mk('h3', null, { textContent: `${all.length} videos on this page` }));
      const list = mk('div', 'list');
      for (const o of all) {
        const it = mk('div', 'it' + (o.candidateId === c.candidateId ? ' cur' : ''));
        const th = mk('div', 'th');
        if (o.thumbnail) th.style.backgroundImage = `url("${o.thumbnail.replace(/"/g, '%22')}")`; else th.textContent = 'no preview';
        const info = mk('div'); info.style.minWidth = '0';
        const tt = mk('div', 'tt', { textContent: o.title });
        const tm = mk('div', 'tm', { textContent: [o.duration ? fmtT(o.duration) : null, o.source.type === 'merge' ? 'video+audio' : o.source.type.toUpperCase(), o.site].filter(Boolean).join(' · ') });
        info.append(tt, tm);
        it.append(th, info);
        if (o.candidateId !== c.candidateId) it.addEventListener('click', () => { carry = settingsSnapshot(); open(o, all); });
        list.appendChild(it);
      }
      side.appendChild(list);
      outer.appendChild(side);
    }

    // ---------- preview ----------
    const stage = mk('div', 'stage');
    let video = null;      // element we control (ours or the page's)
    let mirror = null;     // canvas mirroring the page player
    let ownVideo = false;
    const dom = window.DVO.dom;
    const directUrl = c.source.type === 'file' ? c.source.url : null;
    let pageEl = null;
    if (dom) for (const u of [c.source.url, c.source.video && c.source.video.url, c.thumbnail].filter(Boolean)) { pageEl = dom.elementFor(u); if (pageEl) break; }
    // only fall back to "the" player when the page has exactly one: guessing the autoplaying one on a
    // feed would preview the wrong video
    if (!pageEl && dom) {
      const vids = dom.allVideos();
      // one player, or exactly one that is actually playing: anything more is a guess (feeds autoplay)
      const playing = vids.filter((v) => !v.paused && v.readyState >= 2 && v.videoWidth);
      pageEl = vids.length === 1 ? vids[0] : (playing.length === 1 ? playing[0] : null);
    }

    const note = mk('div', 'note');
    // split video+audio streams are expensive to assemble and the page is already playing them,
    // so mirror the page player when there is one
    const streamable = c.source.type === 'hls' || (c.source.type === 'merge' && !pageEl);
    let loadingPreview = false;
    if (directUrl) {
      video = mk('video', null, { src: directUrl, preload: 'metadata', playsInline: true });
      video.muted = false;
      ownVideo = true;
      stage.appendChild(video);
      note.textContent = 'Preview of the source file';
    } else if (streamable) {
      // assemble the stream into our own player (independent of the page's player / scrolling)
      video = mk('video', null, { preload: 'metadata', playsInline: true });
      video.muted = false;
      ownVideo = true;
      const poster = mk('img', null, { src: c.thumbnail || '' });
      if (c.thumbnail) { stage.appendChild(poster); video.poster = c.thumbnail; }
      stage.appendChild(video);
      video.style.display = 'none';
      loadingPreview = true;
      note.textContent = 'Loading preview…';
      (async () => {
        try {
          if (!window.DVOPreview) {
            const r = await chrome.runtime.sendMessage({ type: 'injectPreview' });
            if (!r || !r.ok) throw new Error((r && r.error) || 'could not load preview libs');
          }
          const res = await window.DVOPreview.load(c, (pct, txt) => { note.textContent = `Loading preview… ${pct}% ${txt || ''}`; });
          video.src = res.url;
          video.style.display = '';
          poster.remove();
          tryAutoPlay();
          note.textContent = `Preview ready (${(res.bytes / 1048576).toFixed(1)} MB, assembled in the page)`;
          setTimeout(() => { if (note.textContent.startsWith('Preview ready')) note.style.opacity = '0'; }, 3000);
        } catch (e) {
          console.warn('[DVO] preview load failed', e);
          note.textContent = `Preview unavailable (${e.message}). Set the times by hand, or use the ⏱ buttons if the page player is on screen.`;
          video.remove();
          // fall back to mirroring the page player if it is on screen
          if (pageEl) { video = pageEl; ownVideo = false; mirror = mk('canvas'); stage.appendChild(mirror); poster.remove(); }
          else video = null;
        } finally { loadingPreview = false; }
      })();
    } else if (pageEl) {
      video = pageEl;
      mirror = mk('canvas');
      stage.appendChild(mirror);
      note.textContent = 'Mirror of the page player. Scrubbing here moves the player on the page.';
    } else {
      const img = mk('img', null, { src: c.thumbnail || '' });
      if (c.thumbnail) stage.appendChild(img); else stage.classList.add('empty');
      note.textContent = all.length > 1 ? 'The player for this video is not on screen (feeds unload players as you scroll). Scroll it into view and reopen ✂, or set the times by hand.' : 'No player found on the page for this stream. Set the times by hand.';
    }
    stage.appendChild(note);

    // ---------- state ----------
    let duration = c.duration || (video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
    const st = { start: 0, end: duration || 10, format: 'mp4-copy', codec: 'vp9', quality: 'medium', targetBytes: 4 * 1048576, noAudio: false };
    let endIsDefault = !duration; // end still a placeholder until the real duration is known
    let settingsSnapshot = () => ({ format: st.format, codec: st.codec, quality: st.quality, targetMB: st.targetBytes / 1048576, noAudio: st.noAudio });
    let loop = true;

    // ---------- timeline ----------
    const tl = mk('div', 'tl');
    const track = mk('div', 'track'), sel = mk('div', 'sel'), hs = mk('div', 'h s'), he = mk('div', 'h e'), ph = mk('div', 'ph');
    const ls = mk('div', 'lbl'), le = mk('div', 'lbl');
    hs.title = 'Drag to set the start'; he.title = 'Drag to set the end';
    tl.append(track, sel, ph, hs, he, ls, le);
    const total = () => Math.max(duration, st.end, 0.1);
    const pct = (t) => `${(t / total()) * 100}%`;
    const layout = () => {
      hs.style.left = pct(st.start); he.style.left = pct(st.end);
      sel.style.left = pct(st.start); sel.style.width = pct(st.end - st.start);
      ls.style.left = pct(st.start); le.style.left = pct(st.end);
      ls.textContent = fmtT(st.start); le.textContent = fmtT(st.end);
      const t = video ? video.currentTime : 0;
      ph.style.left = pct(Math.min(t, total()));
    };
    // which marker the arrow keys move: 'start' | 'end' | 'play'
    let active = 'start';
    const setActive = (a) => { active = a; hs.classList.toggle('act', a === 'start'); he.classList.toggle('act', a === 'end'); ph.classList.toggle('act', a === 'play'); kb.innerHTML = `Arrow keys move <b>${a === 'play' ? 'playhead' : a}</b>: ← → 1 frame · Ctrl 0.1 s · Shift 1 s · Ctrl+Shift 5 s · Home/End · 1/2/3 pick start/playhead/end · , . step playhead`; };
    const frameStep = () => 1 / (video && video.videoWidth ? 30 : 30); // TODO: real fps when known
    const nudge = (delta) => {
      if (active === 'start') { st.start = Math.max(0, Math.min(st.end - 0.1, st.start + delta)); seek(st.start); }
      else if (active === 'end') { st.end = Math.max(st.start + 0.1, Math.min(total(), st.end + delta)); seek(st.end); }
      else if (video) { if (!video.paused) video.pause(); seek(Math.max(0, Math.min(total(), video.currentTime + delta))); }
      syncInputs(); update();
    };
    const timeAt = (clientX) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(total(), ((clientX - r.left) / r.width) * total())); };
    const seek = (t) => { if (video) { try { video.currentTime = t; } catch {} } };
    let dragging = null;
    const onDown = (which) => (e) => { e.preventDefault(); e.stopPropagation(); dragging = which; setActive(which === 's' ? 'start' : which === 'e' ? 'end' : 'play'); if (which !== 'p') (which === 's' ? hs : he).classList.add('drag'); if (video && !video.paused) video.pause(); };
    hs.addEventListener('pointerdown', onDown('s')); he.addEventListener('pointerdown', onDown('e')); ph.addEventListener('pointerdown', onDown('p'));
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const t = timeAt(e.clientX);
      if (dragging === 's') { st.start = Math.min(t, st.end - 0.1); seek(st.start); }
      else if (dragging === 'e') { st.end = Math.max(t, st.start + 0.1); seek(st.end); }
      else { seek(t); layout(); return; }
      syncInputs(); update();
    }, true);
    window.addEventListener('pointerup', () => { if (dragging) { hs.classList.remove('drag'); he.classList.remove('drag'); dragging = null; } }, true);
    track.addEventListener('click', (e) => { setActive('play'); seek(timeAt(e.clientX)); layout(); });
    const kb = mk('div', 'kb');

    // ---------- controls ----------
    const ctl = mk('div', 'ctl');
    const play = mk('button', 'btn p', { textContent: '▶ Play selection' });
    const setS = mk('button', 'btn', { textContent: '[ Set start', title: 'Set start to the playhead (key: [)' });
    const setE = mk('button', 'btn', { textContent: 'Set end ]', title: 'Set end to the playhead (key: ])' });
    const time = mk('span', 'time');
    const loopChk = mk('label', 'chk'); const loopIn = mk('input', null, { type: 'checkbox', checked: true }); loopChk.append(loopIn, document.createTextNode('loop selection'));
    loopIn.addEventListener('change', () => (loop = loopIn.checked));
    const autoChk = mk('label', 'chk'); const autoIn = mk('input', null, { type: 'checkbox' }); autoChk.append(autoIn, document.createTextNode('auto-play preview'));
    autoChk.title = 'Play the selection as soon as the preview is ready. Remembered for next time.';
    let autoPlay = false;
    chrome.storage.local.get('clipAutoPlay').then((r) => { autoPlay = !!r.clipAutoPlay; autoIn.checked = autoPlay; if (autoPlay) tryAutoPlay(); }).catch(() => {});
    autoIn.addEventListener('change', () => { autoPlay = autoIn.checked; chrome.storage.local.set({ clipAutoPlay: autoPlay }).catch(() => {}); if (autoPlay) tryAutoPlay(); });
    let autoPlayed = false;
    const tryAutoPlay = () => {
      if (!autoPlay || autoPlayed || !video || !ownVideo) return;
      const go = () => { if (autoPlayed) return; autoPlayed = true; seek(st.start); video.play().catch(() => { /* blocked until user gesture */ }); };
      if (video.readyState >= 1 && video.src) go(); else video.addEventListener('loadedmetadata', go, { once: true });
    };
    ctl.append(play, setS, setE, time, loopChk, autoChk);
    play.addEventListener('click', () => {
      if (!video) return;
      if (video.paused) { if (video.currentTime < st.start || video.currentTime >= st.end - 0.05) seek(st.start); video.play().catch(() => {}); }
      else video.pause();
    });
    setS.addEventListener('click', () => { if (!video) return; st.start = Math.min(video.currentTime, st.end - 0.1); setActive('start'); syncInputs(); update(); });
    setE.addEventListener('click', () => { if (!video) return; st.end = Math.max(video.currentTime, st.start + 0.1); setActive('end'); syncInputs(); update(); });

    // ---------- options ----------
    const row = mk('div', 'row');
    const sIn = mk('input', null, { type: 'text' }), eIn = mk('input', null, { type: 'text' });
    const fmtSel = mk('select');
    for (const [v, t] of [['mp4-copy', 'MP4 fast (keyframe cut, original quality)'], ['mp4', 'MP4 exact (H.264 re-encode)'], ['webm', 'WebM exact'], ['gif', 'GIF (no audio)'], ['m4a', 'M4A audio (no re-encode when possible)'], ['mp3', 'MP3 audio'], ['wav', 'WAV audio (uncompressed)']]) fmtSel.appendChild(mk('option', null, { value: v, textContent: t }));
    const codecSel = mk('select');
    codecSel.title = 'WebM video codec. VP9 and AV1 use the browser\'s own encoder (usually the GPU) and make much smaller files than VP8 at the same quality.';
    const codecOpts = { vp9: 'VP9 (best size/quality)', av1: 'AV1 (smallest, needs a recent GPU/Chrome)', vp8: 'VP8 (compatible, bigger)' };
    for (const [v, t] of Object.entries(codecOpts)) codecSel.appendChild(mk('option', null, { value: v, textContent: t }));
    codecSel.value = 'vp9';
    // probe encoder availability in this browser and disable what isn't there
    (async () => {
      if (typeof VideoEncoder === 'undefined') { for (const o of codecSel.options) if (o.value !== 'vp8') o.disabled = true; if (st.codec !== 'vp8') { codecSel.value = st.codec = 'vp8'; update(); } return; }
      for (const [v, codec] of [['vp9', 'vp09.00.10.08'], ['av1', 'av01.0.08M.08']]) {
        let ok = false;
        try { ok = (await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 2e6, framerate: 30 })).supported; } catch {}
        const o = [...codecSel.options].find((x) => x.value === v);
        if (!ok) { o.disabled = true; o.textContent += ' (not available)'; if (codecSel.value === v) { codecSel.value = v === 'vp9' && ![...codecSel.options].find((x) => x.value === 'av1').disabled ? 'av1' : 'vp8'; update(); } }
      }
    })();
    const qSel = mk('select');
    for (const [v, t] of [['low', 'Low (small)'], ['medium', 'Medium'], ['high', 'High'], ['target', 'Target file size']]) qSel.appendChild(mk('option', null, { value: v, textContent: t }));
    qSel.value = 'medium';
    const tgt = mk('div', 'tgt');
    const tgtIn = mk('input', null, { type: 'text', value: '4', title: 'Maximum file size in MB' });
    const preset = (mb) => { const b = mk('button', 'mini', { textContent: `${mb} MB` }); b.addEventListener('click', () => { tgtIn.value = String(mb); update(); }); return b; };
    tgt.append(mk('label', null, { textContent: 'Max' }), tgtIn, mk('label', null, { textContent: 'MB' }), preset(4), preset(6), preset(8), preset(16));
    tgtIn.addEventListener('input', update);
    const naChk = mk('label', 'chk'); const naIn = mk('input', null, { type: 'checkbox' }); naChk.append(naIn, document.createTextNode('no audio'));
    naChk.title = 'Drop the audio track. Some sites only accept silent WebMs.';
    naIn.addEventListener('change', update);
    const est = mk('div', 'est');
    const codecLbl = mk('label', null, { textContent: 'Codec' });
    row.append(mk('label', null, { textContent: 'Start' }), sIn, mk('label', null, { textContent: 'End' }), eIn, mk('label', null, { textContent: 'Format' }), fmtSel, codecLbl, codecSel, mk('label', null, { textContent: 'Quality' }), qSel, tgt, naChk, est);
    codecSel.addEventListener('change', update);

    // ---------- presets ----------
    const prow = mk('div', 'row'); prow.style.marginTop = '8px';
    const pSel = mk('select'); pSel.title = 'Saved presets';
    const pSave = mk('button', 'mini', { textContent: '💾 Save as…' });
    const pDef = mk('button', 'mini', { textContent: '★ Set default' });
    const pDel = mk('button', 'mini', { textContent: '🗑' });
    prow.append(mk('label', null, { textContent: 'Preset' }), pSel, pSave, pDef, pDel);
    let presets = [], defaultId = null;
    const settingsOf = () => ({ format: st.format, codec: st.codec, quality: st.quality, targetMB: Math.round((st.targetBytes / 1048576) * 100) / 100, noAudio: st.noAudio });
    const applySettings = (p) => {
      if (!p) return;
      if (p.format) fmtSel.value = p.format;
      if (p.codec) codecSel.value = p.codec;
      if (p.quality) qSel.value = p.quality;
      if (p.targetMB) tgtIn.value = String(p.targetMB);
      naIn.checked = !!p.noAudio;
      update();
    };
    const renderPresets = () => {
      pSel.innerHTML = '';
      pSel.appendChild(mk('option', null, { value: '', textContent: presets.length ? 'Choose a preset' : '(no presets yet)' }));
      for (const p of presets) pSel.appendChild(mk('option', null, { value: p.id, textContent: (p.id === defaultId ? '★ ' : '') + p.name }));
    };
    const loadPresets = async () => {
      try { const r = await chrome.storage.local.get(['clipPresets', 'clipDefaultPreset']); presets = r.clipPresets || []; defaultId = r.clipDefaultPreset || null; } catch {}
      renderPresets();
      const d = presets.find((p) => p.id === defaultId);
      if (d) { pSel.value = d.id; applySettings(d.settings); }
    };
    const savePresets = () => chrome.storage.local.set({ clipPresets: presets, clipDefaultPreset: defaultId }).catch(() => {});
    pSel.addEventListener('change', () => { const p = presets.find((x) => x.id === pSel.value); if (p) applySettings(p.settings); });
    pSave.addEventListener('click', () => {
      const cur = presets.find((x) => x.id === pSel.value);
      const name = prompt('Preset name', cur ? cur.name : `${fmtName()} ${st.quality === 'target' ? Math.round(st.targetBytes / 1048576) + 'MB' : st.quality}`);
      if (!name) return;
      const existing = presets.find((x) => x.name === name);
      if (existing) existing.settings = settingsOf();
      else presets.push({ id: `p${Date.now()}`, name, settings: settingsOf() });
      savePresets(); renderPresets(); pSel.value = (existing || presets[presets.length - 1]).id;
    });
    pDef.addEventListener('click', () => { if (!pSel.value) return; defaultId = defaultId === pSel.value ? null : pSel.value; savePresets(); const v = pSel.value; renderPresets(); pSel.value = v; });
    pDel.addEventListener('click', () => { if (!pSel.value) return; presets = presets.filter((x) => x.id !== pSel.value); if (defaultId === pSel.value) defaultId = null; savePresets(); renderPresets(); });
    const syncInputs = () => { sIn.value = fmtT(st.start); eIn.value = fmtT(st.end); };
    const fromInputs = () => {
      let s = parseT(sIn.value), e = parseT(eIn.value);
      if (!Number.isNaN(s)) st.start = Math.max(0, s);
      if (!Number.isNaN(e)) st.end = Math.max(0.1, e);
      if (duration) { st.start = Math.min(st.start, duration); st.end = Math.min(st.end, duration); }
      if (st.end <= st.start) st.end = st.start + 0.1;
      syncInputs(); update();
    };
    sIn.addEventListener('change', fromInputs); eIn.addEventListener('change', fromInputs);
    fmtSel.addEventListener('change', update); qSel.addEventListener('change', update);

    const actions = mk('div', 'row'); actions.style.marginTop = '12px';
    const go = mk('button', 'btn go');
    const full = mk('button', 'btn');
    const status = mk('div', 'status');
    actions.append(go, full, status);
    // "normal" source = a direct file in a container players open as-is; otherwise the full video is
    // produced in the selected format (HLS/merge already yield MP4, so MP4-fast is a plain download)
    const srcExt = (() => { const m = /\.(mp4|webm|m4v|mov|mkv|avi|flv|ts|m3u8|mpd)(\?|#|$)/i.exec(c.source.url || ''); return m ? m[1].toLowerCase() : null; })();
    const normalSource = c.source.type === 'file' && /^(mp4|webm|m4v|mov|mkv)$/.test(srcExt || '');
    const fmtName = () => fmtSel.options[fmtSel.selectedIndex].textContent.split(' (')[0] + (st.format === 'webm' ? ` ${st.codec.toUpperCase()}` : '');
    full.addEventListener('click', () => {
      const base = { ...c, filenameBase: safe(nameIn.value) };
      let video2;
      const keepsSource = st.format === 'mp4-copy' && !st.noAudio;
      if (keepsSource && (normalSource || c.source.type === 'hls' || c.source.type === 'merge')) video2 = base; // plain download, no re-encode
      else video2 = { ...base, clip: { start: 0, end: duration || 1e7, format: st.format, codec: st.format === 'webm' ? st.codec : null, quality: st.quality, targetBytes: st.targetBytes, noAudio: st.noAudio } };
      chrome.runtime.sendMessage({ type: 'download', videos: [video2] }).then(() => {
        status.className = 'status ok';
        status.textContent = video2.clip ? `Full video queued as ${fmtName()}. Progress is in the popup.` : 'Full video queued. Progress is in the popup.';
      }).catch((e) => { status.className = 'status err'; status.textContent = `Failed to start: ${e.message}`; });
    });
    go.addEventListener('click', () => {
      const video2 = { ...c, filenameBase: safe(nameIn.value), clip: { start: st.start, end: st.end, format: st.format, codec: st.format === 'webm' ? st.codec : null, quality: st.quality, targetBytes: st.targetBytes, noAudio: st.noAudio } };
      chrome.runtime.sendMessage({ type: 'download', videos: [video2] }).then(() => {
        status.className = 'status ok';
        status.textContent = st.format === 'mp4-copy' ? 'Clip queued. Progress is on the badge and in the popup.' : 'Clip queued. Encoding runs in the browser; progress is in the popup.';
      }).catch((e) => { status.className = 'status err'; status.textContent = `Failed to start: ${e.message}`; });
    });

    const hint = mk('div', 'hint', { textContent: 'Drag the [ and ] handles or the playhead, click the bar to scrub. Space = play/pause, [ / ] = set start/end at the playhead, Tab = cycle the active marker, Esc = close.' });

    const top = mk('div', 'top');
    const h2 = mk('h2', null, { textContent: '✂' });
    const safe = (n) => Array.from(n || 'video').filter((ch) => ch.charCodeAt(0) >= 32).join('').replace(/[\/:*?"<>|]/g, '_').trim().slice(0, 150) || 'video';
    const nameIn = mk('input', 'name', { type: 'text', value: safe(c.title), title: 'File name of the downloaded clip (extension is added automatically)', spellcheck: false });
    const extLbl = mk('span', 'ext');
    const x = mk('button', 'x', { textContent: '✕', title: 'Close' });
    top.append(h2, nameIn, extLbl, x);
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameIn.blur(); e.stopPropagation(); });
    box.append(top, stage, ctl, tl, kb, row, prow, actions, hint);

    function update() {
      st.format = fmtSel.value; st.quality = qSel.value; st.noAudio = naIn.checked; st.codec = codecSel.value;
      const isWebm = st.format === 'webm';
      codecSel.style.display = isWebm ? '' : 'none'; codecLbl.style.display = isWebm ? '' : 'none';
      const mb = parseFloat(tgtIn.value); st.targetBytes = (mb > 0 ? mb : 4) * 1048576;
      qSel.disabled = st.format === 'mp4-copy' || st.format === 'wav' || (st.format === 'm4a' && st.quality !== 'target');
      const targetable = st.quality === 'target' && /^(mp4|webm|mp3|m4a)$/.test(st.format);
      tgt.classList.toggle('on', targetable);
      naChk.style.display = /^(mp4-copy|mp4|webm)$/.test(st.format) ? '' : 'none';
      const len = st.end - st.start;
      const h = video && video.videoHeight ? video.videoHeight : null;
      const bytes = estimateBytes(c, st, h);
      est.innerHTML = `clip ${fmtT(len)} · <b>${targetable ? '≤' : '≈'} ${fmtBytes(bytes)}</b>`;
      if (targetable) {
        const audioOnly = /^(mp3|m4a|wav)$/.test(st.format);
        const kbps = Math.round((bytes * 8 * 0.96) / Math.max(0.1, len) / 1000) - (audioOnly || st.noAudio ? 0 : 96);
        est.innerHTML += ` <span style="opacity:.6">(${Math.max(40, kbps)} kbps)</span>`;
        est.title = 'Two-pass encode aimed at this size; the result lands a little under it. A very low kbps means visible quality loss: shorten the clip or raise the limit.';
      } else est.title = st.format === 'mp4-copy' ? 'From the source bitrate; fast cuts start at the previous keyframe, so the clip may begin slightly early' : 'Estimate from typical bitrates for this format and quality. The exact size is shown in the popup when done.';
      go.textContent = `✂ Download clip (${fmtT(len)}, ${fmtName()})`;
      const plain = st.format === 'mp4-copy' && !st.noAudio && normalSource;
      full.textContent = plain ? `⬇ Download source (.${srcExt})` : `⬇ Download full as ${fmtName()}`;
      full.title = plain ? 'Save the original file untouched' : 'Convert the whole video to the selected format and quality. Ignores the clip range.';
      extLbl.textContent = `${fmtT(st.start)}-${fmtT(st.end)} .${{ 'mp4-copy': 'mp4', mp4: 'mp4', webm: 'webm', gif: 'gif', mp3: 'mp3', m4a: 'm4a', wav: 'wav' }[st.format]}`;
      layout();
    }

    // ---------- playback loop / mirror ----------
    let raf = 0;
    const tick = () => {
      if (video) {
        if (!duration && Number.isFinite(video.duration) && video.duration > 0) { duration = video.duration; if (endIsDefault || st.end > duration) { st.end = duration; endIsDefault = false; } syncInputs(); update(); }
        if (!video.paused && loop && video.currentTime >= st.end) { seek(st.start); }
        time.textContent = `${fmtT(video.currentTime)} / ${fmtT(duration)}`;
        play.textContent = video.paused ? '▶ Play selection' : '⏸ Pause';
        if (mirror && video.videoWidth) {
          if (mirror.width !== video.videoWidth) { mirror.width = video.videoWidth; mirror.height = video.videoHeight; }
          try { mirror.getContext('2d').drawImage(video, 0, 0, mirror.width, mirror.height); } catch {}
        }
        layout();
      }
      raf = requestAnimationFrame(tick);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      if (e.key === ' ') { e.preventDefault(); play.click(); }
      else if (e.key === '[') setS.click();
      else if (e.key === ']') setE.click();
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); e.stopPropagation();
        const step = e.ctrlKey && e.shiftKey ? 5 : e.shiftKey ? 1 : e.ctrlKey || e.altKey ? 0.1 : frameStep();
        nudge(e.key === 'ArrowLeft' ? -step : step);
      }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); nudge(e.key === 'Home' ? -1e9 : 1e9); }
      else if (e.key === '1') setActive('start');
      else if (e.key === '2') setActive('play');
      else if (e.key === '3') setActive('end');
      else if (e.key === ',' || e.key === '.') { setActive('play'); nudge(e.key === ',' ? -frameStep() : frameStep()); }
      else if (e.key === 'Tab') { e.preventDefault(); setActive(active === 'start' ? 'play' : active === 'play' ? 'end' : 'start'); }
    };
    const closeFn = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      if (ownVideo && video) { try { video.pause(); if (!streamable) { video.removeAttribute('src'); video.load(); } } catch {} }
      host.remove();
      current = null;
    };
    x.addEventListener('click', closeFn);
    // close on backdrop only when the press started AND ended on the backdrop (not when a handle
    // drag ends outside the dialog)
    let downOnBg = false;
    bg.addEventListener('pointerdown', (e) => { downOnBg = e.target === bg && !dragging; });
    bg.addEventListener('click', (e) => { if (e.target === bg && downOnBg) closeFn(); downOnBg = false; });
    window.addEventListener('keydown', onKey, true);

    document.documentElement.appendChild(host);
    current = { host, close: closeFn };
    syncInputs(); update(); setActive('start');
    if (video && ownVideo && video.src) tryAutoPlay();
    if (carry) { applySettings(carry); carry = null; } else loadPresets();
    if (video) { seek(st.start); if (mirror && pageEl) pageEl.scrollIntoView({ block: 'center', behavior: 'instant' }); }
    raf = requestAnimationFrame(tick);
  }

  function close() { if (current) current.close(); }

  window.DVO = window.DVO || {};
  window.DVO.clipModal = { open, close };
})();
