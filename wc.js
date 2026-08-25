// Download Video OSS: WebCodecs transcode path (VP9 / AV1 / H.264 via Chrome's built-in encoders,
// usually hardware-accelerated) -> WebM via webm.js.  Runs in the offscreen document.
//   window.DVOWebCodecs.transcode(bytes, clip, helpers, onProgress) -> { bytes, ext: 'webm' }
//   clip.codec: 'vp9' | 'av1' | 'h264'  (h264-in-webm is non-standard; we only offer vp9/av1 here)
//   helpers.ffmpegExec(inputs:{name:Uint8Array}, args:string[], outputs:string[]) -> {name:Uint8Array}
//   helpers.parseMp4Samples(u8) -> tracks (from mp4fix.js)
(() => {
  const CODEC = {
    vp9: { enc: 'vp09.00.10.08', webm: 'V_VP9' },
    av1: { enc: 'av01.0.08M.08', webm: 'V_AV1' },
  };

  async function isSupported(codec, width = 1280, height = 720) {
    try {
      if (typeof VideoEncoder === 'undefined') return false;
      const r = await VideoEncoder.isConfigSupported({ codec: CODEC[codec].enc, width, height, bitrate: 2_000_000, framerate: 30 });
      return !!(r && r.supported);
    } catch { return false; }
  }

  // Get an H.264-in-MP4 copy of just the clip range (fast), so VideoDecoder can read it directly.
  // If the source is already a progressive MP4 with avc1, we still re-cut it: it keeps memory bounded
  // and guarantees a keyframe at the start. ultrafast + crf 12 ≈ visually lossless intermediate.
  async function prepareVideo(bytes, inputName, clip, ffmpegExec, onProgress) {
    const dur = Math.max(0.1, clip.end - clip.start);
    onProgress({ phase: 'decoding', percent: 0, note: 'reading the video (1 of 3)' });
    const out = await ffmpegExec({ [inputName]: bytes }, ['-hide_banner', '-ss', String(clip.start), '-i', inputName, '-t', String(dur),
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', '9999', '-movflags', '+faststart', 'prep.mp4'], ['prep.mp4'],
      (t) => onProgress({ phase: 'decoding', percent: Math.min(30, Math.round((t / dur) * 30)), note: 'reading the video (1 of 3)' }));
    return out['prep.mp4'];
  }

  async function prepareAudio(bytes, inputName, clip, ffmpegExec, onProgress) {
    const dur = Math.max(0.1, clip.end - clip.start);
    try {
      const out = await ffmpegExec({ [inputName]: bytes }, ['-hide_banner', '-ss', String(clip.start), '-i', inputName, '-t', String(dur),
        '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pcm.raw'], ['pcm.raw'],
        (t) => onProgress && onProgress({ phase: 'decoding', percent: 30 + Math.min(10, Math.round((t / dur) * 10)), note: 'reading the audio (2 of 3)' }));
      return out['pcm.raw'];
    } catch { return null; } // no audio track
  }

  async function encodeAudio(pcm, onChunk, bitrate = 96000) {
    const sampleRate = 48000, channels = 2;
    const frames = Math.floor(pcm.length / 4 / channels);
    let description = null;
    const enc = new AudioEncoder({
      output: (chunk, meta) => { if (meta && meta.decoderConfig && meta.decoderConfig.description && !description) description = new Uint8Array(meta.decoderConfig.description.slice(0)); onChunk(chunk); },
      error: (e) => { throw e; },
    });
    enc.configure({ codec: 'opus', sampleRate, numberOfChannels: channels, bitrate });
    const f32 = new Float32Array(pcm.buffer, pcm.byteOffset, frames * channels);
    const STEP = 960 * 20; // 20 ms * 20
    for (let i = 0; i < frames; i += STEP) {
      const n = Math.min(STEP, frames - i);
      const data = new AudioData({ format: 'f32', sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((i / sampleRate) * 1e6), data: f32.subarray(i * channels, (i + n) * channels) });
      enc.encode(data); data.close();
      while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
    }
    await enc.flush(); enc.close();
    return { description, sampleRate, channels };
  }

  async function transcode(bytes, inputName, clip, helpers, onProgress) {
    const spec = CODEC[clip.codec];
    if (!spec) throw new Error(`unsupported WebCodecs codec ${clip.codec}`);
    const dur = Math.max(0.1, clip.end - clip.start);

    // 1) intermediate H.264 + PCM (ffmpeg does all the demux/decode heavy lifting reliably)
    const prep = await prepareVideo(bytes, inputName, clip, helpers.ffmpegExec, onProgress);
    const pcm = clip.noAudio ? null : await prepareAudio(bytes, inputName, clip, helpers.ffmpegExec, onProgress);

    // 2) samples
    const tracks = helpers.parseMp4Samples(prep);
    const vt = tracks.find((t) => t.kind === 'video');
    if (!vt || !vt.samples.length) throw new Error('no video in intermediate');
    const width = vt.width, height = vt.height;
    const fps = Math.max(1, Math.min(120, Math.round(vt.samples.length / dur)));

    // 3) encoder
    const totalBps = ((clip.targetBytes || 4 * 1048576) * 8 * 0.96) / dur;
    // a fixed 96 kbps of Opus swallows a small budget whole, so cap it at a fifth of it
    const audioBps = clip.noAudio ? 0 : (clip.quality === 'target'
      ? Math.max(24_000, Math.min(96_000, Math.round(totalBps * 0.2))) : 96_000);
    const targetBps = (() => {
      if (clip.quality === 'target') return Math.max(20_000, Math.round(totalBps - audioBps));
      const base = { 2160: 9e6, 1440: 5e6, 1080: 2.4e6, 720: 1.3e6, 480: 0.7e6, 360: 0.45e6 };
      const h = [2160, 1440, 1080, 720, 480, 360].find((k) => height >= k) || 360;
      return Math.round(base[h] * ({ low: 0.55, medium: 1, high: 1.8 }[clip.quality] || 1) * (clip.codec === 'av1' ? 0.8 : 1));
    })();
    async function encodeVideo(bps) {
    const chunks = [];
    let vDesc = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !vDesc) vDesc = new Uint8Array(meta.decoderConfig.description.slice(0));
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        chunks.push({ data, timestamp: chunk.timestamp, key: chunk.type === 'key' });
      },
      error: (e) => { encErr = e; },
    });
    let encErr = null;
    const cfg = { codec: spec.enc, width, height, bitrate: bps, bitrateMode: clip.quality === 'target' ? 'constant' : 'variable', framerate: fps, latencyMode: 'quality' };
    let sup = await VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: 'prefer-hardware' });
    if (sup.supported) encoder.configure({ ...cfg, hardwareAcceleration: 'prefer-hardware' });
    else { sup = await VideoEncoder.isConfigSupported(cfg); if (!sup.supported) throw new Error(`${clip.codec.toUpperCase()} encoder not available in this browser`); encoder.configure(cfg); }

    // 4) decode -> encode
    let decoded = 0, decErr = null;
    const total = vt.samples.length;
    const t0 = vt.samples[0].cts;
    const decoder = new VideoDecoder({
      output: (frame) => {
        const keyFrame = decoded % Math.max(1, Math.round(fps * 5)) === 0; // keyframe every ~5 s
        const ts = Math.max(0, frame.timestamp);
        try { encoder.encode(frame, { keyFrame }); } catch (e) { decErr = e; }
        frame.close();
        decoded++;
        if (decoded % 5 === 0) onProgress({ phase: 'encoding', percent: Math.min(99, 40 + Math.round((decoded / total) * 55)), note: `${clip.codec.toUpperCase()} ${pass > 1 ? `pass ${pass}, ` : ''}${decoded}/${total} frames` });
      },
      error: (e) => { decErr = e; },
    });
    decoder.configure({ codec: vt.codec, description: vt.description, optimizeForLatency: false });
    for (const s of vt.samples) {
      if (decErr || encErr) break;
      const chunk = new EncodedVideoChunk({ type: s.sync ? 'key' : 'delta', timestamp: Math.round(((s.cts - t0) / vt.timescale) * 1e6), duration: Math.round((s.dur / vt.timescale) * 1e6), data: prep.subarray(s.offset, s.offset + s.size) });
      decoder.decode(chunk);
      while (decoder.decodeQueueSize > 12 || encoder.encodeQueueSize > 12) await new Promise((r) => setTimeout(r, 2));
    }
    await decoder.flush(); decoder.close();
    await encoder.flush(); encoder.close();
    if (decErr) throw new Error(`decode failed: ${decErr.message || decErr}`);
    if (encErr) throw new Error(`encode failed: ${encErr.message || encErr}`);
    if (!chunks.length) throw new Error('encoder produced no frames');
    let bytes = 0;
    for (const c of chunks) bytes += c.data.length;
    return { chunks, vDesc, bytes };
    }

    let pass = 1;
    let enc = await encodeVideo(targetBps);
    // WebCodecs rate control is a hint, not a contract: if the result misses the requested size,
    // scale the bitrate by how far off it was and encode once more.
    if (clip.quality === 'target') {
      const videoBudget = ((clip.targetBytes - (audioBps * dur) / 8) * 0.98);
      if (enc.bytes > videoBudget * 1.05 && videoBudget > 0) {
        pass = 2;
        const corrected = Math.max(15_000, Math.round(targetBps * (videoBudget / enc.bytes) * 0.97));
        onProgress({ phase: 'encoding', percent: 40, note: 'adjusting bitrate to fit the size limit' });
        enc = await encodeVideo(corrected);
      }
    }
    const { chunks, vDesc } = enc;

    // 5) audio
    let audio = null;
    if (pcm && pcm.length > 8) {
      onProgress({ phase: 'encoding', percent: 99, note: 'encoding audio (Opus)…' });
      const aChunks = [];
      const meta = await encodeAudio(pcm, (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); aChunks.push({ data: d, timestamp: chunk.timestamp, key: true }); }, audioBps);
      audio = { codec: 'A_OPUS', sampleRate: meta.sampleRate, channels: meta.channels, description: meta.description, chunks: aChunks };
    }

    // 6) mux
    const out = window.muxWebM({ video: { codec: spec.webm, width, height, description: clip.codec === 'av1' ? vDesc : null, chunks }, audio, duration: dur * 1e6 });
    return { bytes: out, ext: 'webm' };
  }

  window.DVOWebCodecs = { transcode, isSupported, CODEC };
})();
