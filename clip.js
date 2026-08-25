// Download Video OSS: clip / convert engine (ES module, runs in the offscreen document).
// Wraps ffmpeg.wasm (vendor/ffmpeg + vendor/ffmpeg-core, single-threaded build).
// Exposes window.DVOClip.run(bytes, inputName, clip, onProgress) -> { bytes, ext }
//   clip = { start, end (seconds), format: 'mp4-copy'|'mp4'|'webm'|'gif'|'mp3', quality: 'low'|'medium'|'high' }
import { FFmpeg } from './vendor/ffmpeg/index.js';

let ffmpeg = null;
let loading = null;

async function get() {
  if (ffmpeg) return ffmpeg;
  if (!loading) {
    loading = (async () => {
      const ff = new FFmpeg();
      await ff.load({
        coreURL: chrome.runtime.getURL('vendor/ffmpeg-core/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('vendor/ffmpeg-core/ffmpeg-core.wasm'),
      });
      ffmpeg = ff;
      return ff;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

// NOTE: libopus and libvpx-vp9 both crash this wasm build (memory faults), so WebM = VP8 + Vorbis.
// clip.quality: 'low' | 'medium' | 'high' | 'target'   (target => clip.targetBytes, 2-pass ABR)
// clip.noAudio: true drops the audio track (some sites reject WebMs with audio)
const EXT = { 'mp4-copy': 'mp4', mp4: 'mp4', webm: 'webm', gif: 'gif', mp3: 'mp3', m4a: 'm4a', wav: 'wav' };
const AUDIO_ONLY = /^(mp3|m4a|wav)$/;
const AUDIO_KBPS = { mp4: 96, webm: 96 };

// returns an array of ffmpeg arg lists (1 or 2 passes)
function argsFor(clip, inName, outName) {
  const q = clip.quality || 'medium';
  const dur = Math.max(0.1, clip.end - clip.start);
  const head = ['-hide_banner', '-ss', String(clip.start), '-i', inName, '-t', String(dur)];
  const audioOff = !!clip.noAudio;
  // bitrate for an audio-only output: a tier, or whatever fits the requested file size
  const audioKbps = (tiers, min, max) => {
    if (q !== 'target') return `${tiers[q] || tiers.medium}k`;
    const kbps = ((clip.targetBytes || 4 * 1048576) * 8 * 0.98) / dur / 1000;
    return `${Math.max(min, Math.min(max, Math.round(kbps)))}k`;
  };
  const targetVideoKbps = () => {
    const total = Math.max(16, ((clip.targetBytes || 4 * 1048576) * 8 * 0.96) / dur / 1000); // 4% container/overhead margin
    return Math.max(40, Math.round(total - (audioOff ? 0 : AUDIO_KBPS[clip.format] || 96)));
  };
  switch (clip.format) {
    case 'mp4-copy':
      return [[...head, ...(audioOff ? ['-an'] : []), '-c', 'copy', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', outName]];
    case 'mp4': {
      const audio = audioOff ? ['-an'] : ['-c:a', 'aac', '-b:a', '96k'];
      if (q === 'target') {
        const v = ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${targetVideoKbps()}k`, '-pix_fmt', 'yuv420p'];
        return [
          [...head, ...v, '-pass', '1', '-passlogfile', 'pl', '-an', '-f', 'null', '/dev/null'],
          [...head, ...v, '-pass', '2', '-passlogfile', 'pl', ...audio, '-movflags', '+faststart', outName],
        ];
      }
      const crf = { low: '28', medium: '23', high: '18' }[q];
      return [[...head, '-c:v', 'libx264', '-preset', q === 'high' ? 'faster' : 'veryfast', '-crf', crf, '-pix_fmt', 'yuv420p', ...audio, '-movflags', '+faststart', outName]];
    }
    case 'webm': {
      const audio = audioOff ? ['-an'] : ['-c:a', 'libvorbis', '-q:a', '3'];
      if (q === 'target' || q === 'high') {
        // 2-pass "good" VP8: ~2x the compression efficiency of the realtime preset, ~1.3x realtime speed at 720p
        const kbps = q === 'target' ? targetVideoKbps() : 2500;
        const v = ['-c:v', 'libvpx', '-b:v', `${kbps}k`, '-deadline', 'good', '-cpu-used', '5', '-auto-alt-ref', '1', '-lag-in-frames', '16'];
        return [
          [...head, ...v, '-pass', '1', '-passlogfile', 'pl', '-an', '-f', 'null', '/dev/null'],
          [...head, ...v, '-pass', '2', '-passlogfile', 'pl', ...audio, outName],
        ];
      }
      const cap = { low: '600k', medium: '1200k' }[q];
      const crf = { low: '24', medium: '14' }[q];
      return [[...head, '-c:v', 'libvpx', '-crf', crf, '-b:v', cap, '-deadline', 'realtime', '-cpu-used', '8', ...audio, outName]];
    }
    case 'gif': {
      const vf = { low: 'fps=10,scale=320:-1:flags=lanczos', medium: 'fps=15,scale=480:-1:flags=lanczos', high: 'fps=20,scale=640:-1:flags=lanczos', target: 'fps=12,scale=400:-1:flags=lanczos' }[q];
      return [[...head, '-vf', `${vf},split[a][b];[a]palettegen[p];[b][p]paletteuse`, '-an', outName]];
    }
    case 'mp3':
      return [[...head, '-vn', '-c:a', 'libmp3lame', '-b:a', audioKbps({ low: 128, medium: 192, high: 320 }, 32, 320), outName]];
    case 'm4a':
      // the source audio is usually already AAC, so copy it (instant, lossless); run() retries with
      // an encode if the copy is rejected
      if (!clip.forceEncode && clip.quality !== 'target') return [[...head, '-vn', '-c:a', 'copy', '-movflags', '+faststart', outName]];
      return [[...head, '-vn', '-c:a', 'aac', '-b:a', audioKbps({ low: 128, medium: 192, high: 256 }, 32, 320), '-movflags', '+faststart', outName]];
    case 'wav':
      return [[...head, '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', outName]];
    default:
      throw new Error(`unknown clip format ${clip.format}`);
  }
}

let busy = Promise.resolve();
const lock = async () => { const prev = busy; let release; busy = new Promise((r) => (release = r)); await prev; return release; };

// generic helper used by the WebCodecs path: run one ffmpeg command over in-memory files
async function ffmpegExec(inputs, args, outputs, onSeconds) {
  const release = await lock();
  try {
    const ff = await get();
    const names = Object.keys(inputs);
    let logTail = '';
    const onLog = ({ message }) => { logTail = (logTail + '\n' + message).slice(-1500); };
    ff.on('log', onLog);
    const onP = onSeconds ? ({ time }) => onSeconds(time / 1e6) : null;
    if (onP) ff.on('progress', onP);
    try {
      for (const n of names) await ff.writeFile(n, inputs[n]);
      const ret = await ff.exec(args);
      if (ret !== 0) throw new Error((logTail.split('\n').filter((l) => /error|invalid|fail|not supported|unsupported/i.test(l)).pop() || `ffmpeg exit ${ret}`).trim());
      const out = {};
      for (const o of outputs) out[o] = await ff.readFile(o);
      return out;
    } finally {
      ff.off('log', onLog);
      if (onP) ff.off('progress', onP);
      for (const n of [...names, ...outputs]) { try { await ff.deleteFile(n); } catch {} }
    }
  } finally { release(); }
}

async function run(bytes, inputName, clip, onProgress) {
  // WebCodecs codecs (VP9 / AV1) -> wc.js; everything else -> ffmpeg.wasm
  if (clip.format === 'webm' && /^(vp9|av1)$/.test(clip.codec || '')) {
    if (!window.DVOWebCodecs) throw new Error('WebCodecs path not loaded');
    return window.DVOWebCodecs.transcode(bytes, inputName, clip, { ffmpegExec, parseMp4Samples: window.parseMp4Samples }, onProgress || (() => {}));
  }
  // ffmpeg.wasm handles one exec at a time: serialise
  const release = await lock();
  try {
    onProgress && onProgress({ phase: 'loading', percent: 0 });
    const ff = await get();
    const inName = `in.${(inputName.split('.').pop() || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4'}`;
    const outName = `out.${EXT[clip.format]}`;
    const dur = Math.max(0.1, clip.end - clip.start);
    let passNo = 0, passCount = 1;
    const onP = ({ time }) => {
      const within = Math.max(0, Math.min(1, time / 1e6 / dur));
      const pct = Math.round(((passNo + within) / passCount) * 100);
      onProgress && onProgress({ phase: 'encoding', percent: Math.min(99, pct), note: passCount > 1 ? `pass ${passNo + 1}/${passCount}` : null });
    };
    ff.on('progress', onP);
    let logTail = '';
    const onLog = ({ message }) => { logTail = (logTail + '\n' + message).slice(-1500); };
    ff.on('log', onLog);
    try {
      await ff.writeFile(inName, bytes);
      const runPasses = async (cfg) => {
        const passes = argsFor(cfg, inName, outName);
        for (let i = 0; i < passes.length; i++) {
          passNo = i; passCount = passes.length;
          const ret = await ff.exec(passes[i]);
          if (ret !== 0) {
            const why = (logTail.split('\n').filter((l) => /error|invalid|fail|not supported|unsupported/i.test(l)).pop() || `ffmpeg exit ${ret}`).trim();
            throw new Error(why);
          }
        }
      };
      try {
        await runPasses(clip);
      } catch (e) {
        if (clip.format !== 'm4a' || clip.forceEncode) throw e;
        try { await ff.deleteFile(outName); } catch {}
        await runPasses({ ...clip, forceEncode: true }); // source audio was not AAC
      }
      const out = await ff.readFile(outName);
      return { bytes: out, ext: EXT[clip.format] };
    } finally {
      ff.off('progress', onP);
      ff.off('log', onLog);
      try { await ff.deleteFile(inName); } catch {}
      try { await ff.deleteFile(outName); } catch {}
      for (const f of ['pl-0.log', 'pl-0.log.mbtree', 'pl-0.log.temp']) { try { await ff.deleteFile(f); } catch {} }
    }
  } finally {
    release();
  }
}

window.DVOClip = { run, EXT, ffmpegExec };
