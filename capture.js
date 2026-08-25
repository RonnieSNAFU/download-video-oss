// Download Video OSS: player capture (runs in the page's own world).
//
// Streaming players hand the browser their media through SourceBuffer.appendBuffer. Keeping a copy of
// those buffers gives the real video and audio without asking the server for anything, so it works
// where a stream URL is signed for the player alone. It only holds what has actually played.
(() => {
  if (window.__dvoCapture) return;
  const MS = window.MediaSource;
  const SB = window.SourceBuffer;
  if (!MS || !SB) return;

  const LIMIT = 1200 * 1024 * 1024; // stop before the tab runs out of memory
  const groups = new Map(); // id -> { id, url, streams: Map(sbId -> {mime, parts, bytes}), truncated }
  let total = 0, nextGroup = 1, nextStream = 1;
  const group = (id) => {
    if (!groups.has(id)) groups.set(id, { id, url: null, streams: new Map(), truncated: false });
    return groups.get(id);
  };

  const origCreateURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateURL.call(URL, obj);
    try {
      if (obj instanceof MS) {
        if (!obj.__dvoId) obj.__dvoId = nextGroup++;
        group(obj.__dvoId).url = url;
      }
    } catch {}
    return url;
  };

  const origAdd = MS.prototype.addSourceBuffer;
  MS.prototype.addSourceBuffer = function (mime) {
    const sb = origAdd.call(this, mime);
    try {
      if (!this.__dvoId) this.__dvoId = nextGroup++;
      sb.__dvoGroup = this.__dvoId;
      sb.__dvoStream = nextStream++;
      group(this.__dvoId).streams.set(sb.__dvoStream, { mime: String(mime || ''), parts: [], bytes: 0 });
    } catch {}
    return sb;
  };

  const keep = function (data) {
    try {
      const g = groups.get(this.__dvoGroup);
      const s = g && g.streams.get(this.__dvoStream);
      if (!s || !data) return;
      if (total >= LIMIT) { g.truncated = true; return; }
      const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const copy = view.slice();
      s.parts.push(copy);
      s.bytes += copy.length;
      total += copy.length;
    } catch {}
  };
  const origAppend = SB.prototype.appendBuffer;
  SB.prototype.appendBuffer = function (data) { keep.call(this, data); return origAppend.call(this, data); };
  if (SB.prototype.appendBufferAsync) {
    const origAsync = SB.prototype.appendBufferAsync;
    SB.prototype.appendBufferAsync = function (data) { keep.call(this, data); return origAsync.call(this, data); };
  }

  const joinStream = (s) => {
    const out = new Uint8Array(s.bytes);
    let o = 0;
    for (const p of s.parts) { out.set(p, o); o += p.length; }
    return out;
  };

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (e.source !== window || !msg || msg.__dvo !== 'req') return;
    if (msg.op === 'status') {
      const list = [];
      for (const g of groups.values()) {
        let bytes = 0;
        const streams = [];
        for (const s of g.streams.values()) { bytes += s.bytes; if (s.bytes) streams.push({ mime: s.mime, bytes: s.bytes }); }
        if (bytes) list.push({ id: g.id, url: g.url, bytes, streams, truncated: g.truncated });
      }
      window.postMessage({ __dvo: 'res', rid: msg.rid, groups: list }, '*');
    } else if (msg.op === 'take') {
      const g = groups.get(msg.id);
      if (!g) { window.postMessage({ __dvo: 'res', rid: msg.rid, error: 'nothing captured' }, '*'); return; }
      const streams = [];
      const transfer = [];
      for (const s of g.streams.values()) {
        if (!s.bytes) continue;
        const joined = joinStream(s);
        streams.push({ mime: s.mime, buffer: joined.buffer });
        transfer.push(joined.buffer);
        // the copy has been handed over: release it here so the tab gets the memory back
        s.parts = []; s.bytes = 0;
      }
      total = 0;
      window.postMessage({ __dvo: 'res', rid: msg.rid, streams, truncated: g.truncated }, '*', transfer);
    }
  });

  window.__dvoCapture = true;
})();
