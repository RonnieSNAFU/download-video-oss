# Download Video OSS

Open source Chrome extension (Manifest V3) that finds videos on any site and saves them as a
normal, seekable MP4 from the toolbar popup. No servers, no accounts, no telemetry.

## How it finds videos
1. Site plugins (`sites/*.js`). Exact title, thumbnail, duration and quality list for players
   that obfuscate or split their streams. Plugins are small and easy to add (see below).
2. Network sniffing (`background.js`). A read-only `webRequest` listener records every HLS
   playlist (`.m3u8`), DASH manifest (`.mpd`) and direct video file the tab loads. This is what
   makes players that use MSE (`blob:` sources) work on sites without a plugin. Start playback
   first so the player requests its stream, then open the popup.
3. Page scan (`core/dom.js`, `sites/generic.js`). Finds every player, including inside shadow
   DOM, and matches each sniffed stream to its player by shared URL tokens (media ids,
   file names) so each entry gets its own poster, duration, title and link. Metadata is cached as
   players appear, so it survives feeds that unload items as you scroll.

The popup lists every candidate with a thumbnail, title, type and duration. Click to select
(click again to unselect), or use "select all". Selecting an entry outlines its player on the page.

## Downloading
- HLS: master playlist to best variant, AES-128 decryption, separate audio renditions merged.
  TS segments are remuxed with mux.js (vendored, Apache-2.0); fMP4 segments are used as they
  are. `mp4fix.js` rebuilds the result as a progressive MP4 with real sample tables, so seeking
  works in VLC, Windows Media Player and everything else.
- Split streams: video-only and audio-only streams are fetched in 10 MB ranges and merged into one MP4.
- Direct files: saved through `chrome.downloads`, streamed straight to disk.
- DASH: detected but not downloadable yet.
- Downloads run outside the tab (background worker plus an offscreen document), so the popup can
  be closed. The badge shows progress. Two jobs run at a time per tab; each card has its own bar.
- A session `declarativeNetRequest` rule sends the page URL as Referer on the engine's own
  requests, because many CDNs refuse segment requests without one.

## Streams a site will not hand over (player capture)
Some sites sign their stream URLs for their own player, so fetching one anywhere else is refused.
For those, `capture.js` keeps a copy of the media the page's player feeds to the decoder
(`SourceBuffer.appendBuffer`), which needs no request of its own. Entries tagged FROM PLAYER are
assembled from that: fragmented MP4 goes through the MP4 writer, WebM through `webmremux.js`, and
video and audio are merged into one file.

It only holds what has actually played, so let the video run through at the quality you want
before downloading, and pick the quality in the player first. Clipping is not available for these
entries because the data lives in the page, not in the extension; download first, then clip the
file. Encrypted (DRM) streams stay out of reach.

## Pages that only link to videos (imageboards, forums, directory listings)
Nothing plays, so nothing is sniffed. Tick "Scan page links for video files on <site>" in the
popup to list every linked `.mp4/.webm/.mov/.m3u8` with its thumbnail. Off by default because a
board can have hundreds; remembered per site.

## When a site is not recognised
- Pick on page: click the player you mean. A direct `<video src>` becomes a download right away;
  for streaming players, the streams it fetches while playing are attributed to it.
- Add URL: paste any `.m3u8`, `.mp4` or `.mpd` URL (DevTools, Network tab, filter `m3u8`). It is
  downloaded with this page as Referer.
- Diagnostics: copies a JSON report (page, og tags, every sniffed and ignored media request,
  every `<video>` including shadow DOM, iframes, plugin matches) to the clipboard. Send it to get
  a plugin written for the site.

## Clip and convert (✂ on any card)
✂ opens an editor on the page with its own player. Direct files play right away. HLS and split
streams are assembled into a playable MP4 inside the page (`core/preview.js`, injected on demand;
the page origin already has CORS access to what its player fetched), so the preview does not depend
on the site's player or on what is scrolled into view. A sidebar lists the other detected videos.

Timeline: two draggable handles (start `[`, end `]`), a draggable playhead, a selection band, and
loop playback of the selection. Keyboard: `1` `2` `3` pick start, playhead or end (or `Tab`);
arrow keys nudge the active marker by one frame, with Ctrl 0.1 s, Shift 1 s, Ctrl+Shift 5 s;
Home and End jump; `,` and `.` step the playhead; `[` and `]` set a handle at the playhead;
Space plays or pauses; Esc closes. The file name is editable at the top. "Auto-play preview"
starts playback as soon as the preview is ready.

Formats and codecs:
- MP4 fast: stream copy, instant, original quality; the cut snaps to the previous keyframe.
- MP4 exact: H.264 (libx264 in ffmpeg.wasm).
- WebM exact with a codec choice. VP9 (default) and AV1 are encoded by Chrome's WebCodecs
  `VideoEncoder` (usually hardware) with Opus audio and muxed by `webm.js`; options are greyed
  out when the browser or GPU lacks the encoder. VP8 uses ffmpeg.wasm libvpx with Vorbis.
- GIF (no audio).
- Audio only: M4A (copies the source audio track when it is already AAC, so it is instant and
  lossless, otherwise re-encodes), MP3, or uncompressed WAV.

Quality: Low, Medium, High, or Target file size (MB, with 4/6/8/16 presets), for video and
for MP3 and M4A audio. The encoder is driven
to land just under the limit: two-pass for VP8 and H.264, constant bitrate for VP9 and AV1. The
panel shows the clip length, the resulting kbps and an estimated or maximum size; the exact size
is shown in the popup when the job finishes. "No audio" drops the audio track for sites that only accept silent WebMs.

Presets: save the current format, codec, quality, size and audio settings under a name, pick them
from the Preset list, mark one as default (applied whenever the editor opens), or delete them.

Next to "Download clip" there is a second button: "Download source" saves the original file
untouched when the source is a normal container, otherwise "Download full" converts the whole
video to the selected format, ignoring the clip range.

Engine notes: ffmpeg.wasm (vendored, about 32 MB, single-threaded) does cutting, H.264, VP8, GIF,
MP3 and the decode step for the WebCodecs path. libvpx-vp9 and libopus crash in this wasm build,
which is why VP9 and Opus go through WebCodecs instead.

## Not supported: YouTube
YouTube delivers its media so that only its own player may request it, and that check happens on
their servers. No browser extension can download it, so the extension does not try: on those
domains it detects nothing and shows a short note pointing at a desktop tool such as
[yt-dlp](https://github.com/yt-dlp/yt-dlp), which runs the player code of the site itself. Player
capture is disabled there as well, so no tab memory is spent on it.

## Install
`chrome://extensions`, turn on Developer mode, Load unpacked, pick this folder.
Permissions: `webRequest` and `<all_urls>` (to see media requests on any site), `downloads`,
`offscreen`, `declarativeNetRequest` (Referer rule), `scripting` (preview loader), `storage`
(presets and per-site settings), `tabs`, `activeTab`, `webNavigation`.

## Adding a site plugin
Create `sites/<name>.js`:
```js
DVO.register({
  name: 'example.com',
  match: (loc) => loc.hostname.endsWith('example.com'),
  detect: () => ({ id, title, thumbnail, duration, pageUrl, source: { type: 'hls'|'file', url } }) || null,
  enrich: (sniffed) => ({ title, thumbnail, duration, pageUrl }) || { skip: true } || null, // optional
});
```
and add it to `content_scripts.js` in `manifest.json` before `sites/generic.js`.

## Layout
- `manifest.json`
- `background.js`: network sniffer, badge, download jobs, Referer rule, preview lib injection
- `offscreen.html` / `offscreen.js`: HLS and merge engine in an offscreen document
- `clip.js` + `vendor/ffmpeg*`: ffmpeg.wasm clip and convert; `wc.js`: WebCodecs VP9/AV1/Opus; `webm.js`: WebM muxer
- `core/registry.js`: plugin registry; `core/dom.js`: player discovery and stream-to-player matching;
  `core/content.js`: candidate list; `core/clipmodal.js`: clip editor; `core/preview.js`: in-page preview loader
- `sites/*.js`: site plugins (named by the player technique they handle) and the generic fallback
- `popup.html` / `popup.js`, `editor.html` / `editor.js` (clip a file from your computer)
- `mux.min.js` (TS to fMP4), `mp4fix.js` (fMP4 to progressive MP4, MP4 sample reader)
- `capture.js` (player capture, page world), `webm.js` + `webmremux.js` (WebM muxer and stream reader)
