# Chrome Web Store listing (paste into the Developer Dashboard)

Name: Download Video OSS
Category: Productivity (or Tools)
Language: English

Summary (132 chars max):
Find and save videos from any site as MP4. Clip and convert (VP9/AV1 WebM, GIF, MP3) with a built-in editor. Open source.

Description:
Download Video OSS finds the videos on the page you are on and saves them as a normal MP4 file.

What it does
- Detects videos on any site: direct files, HLS streams and split video+audio streams, including players that hide their source. Start playback, open the popup, pick the video.
- Saves real, seekable MP4 files (HLS segments are rebuilt into a standard MP4).
- Thumbnails, titles and durations for each detected video, with multi-select and per-item progress.
- Built-in clip editor: trim with draggable start/end handles, preview, keyboard fine control, and convert to MP4, WebM (VP9 or AV1 with Opus, or VP8), GIF or MP3. Set a target file size and the encoder aims for it. Save your settings as presets.
- Helpers for unusual sites: pick the player on the page, paste a stream URL, or copy a diagnostics report.

Privacy
Everything runs in your browser. No servers, no accounts, no analytics. See the privacy policy in the repository.

Open source (MIT): https://github.com/RonnieSNAFU/download-video-oss

Note: this extension is for saving content you have the right to download. Respect each site's terms and copyright.

Privacy policy URL:
https://github.com/RonnieSNAFU/download-video-oss/blob/main/PRIVACY.md

Single purpose description (Privacy tab):
Detects videos on the current page and lets the user download or clip them.

Permission justifications (Privacy tab):
- webRequest + host permissions (all sites): required to observe the media requests a page makes so the extension can find the video stream on any site. Read-only; no requests are blocked or modified except the extension's own download requests.
- downloads: saves the chosen file to the user's Downloads folder.
- offscreen: runs the stream assembler and the video converter (ffmpeg.wasm, WebCodecs) off the page.
- scripting: injects the preview loader into the tab when the user opens the clip editor.
- declarativeNetRequest: adds a Referer header to the extension's own download requests, which many video hosts require. Session rules only, scoped to the extension's own requests.
- storage: stores user presets and per-site preferences locally.
- tabs, activeTab, webNavigation: identify the tab the popup is acting on and reset detected videos when the tab navigates.
- Remote code: none. All code is packaged; ffmpeg.wasm is bundled, not fetched.

Data usage disclosure: the extension does not collect or transmit user data.

Assets in this folder:
- ../icons/icon128.png : store icon (128x128)
- promo_440x280.png : small promo tile
Screenshots (1280x800 or 640x400) are still needed: take one of the popup with a detected list and one of the clip editor.
