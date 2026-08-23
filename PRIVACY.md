# Privacy policy for Download Video OSS

Download Video OSS runs entirely in your browser.

- It does not collect, store or transmit personal data, browsing history or analytics.
- It has no server. Nothing you do with it leaves your computer except the requests needed to
  fetch the video you chose from the site that hosts it.
- It reads network requests in your tabs only to find video streams (playlists and media
  files). This information stays in memory for the open tab and is discarded when the tab
  closes or navigates.
- Settings (presets, the per-site "scan links" switch, the auto-play preference) are saved in
  Chrome's local extension storage on your device only.
- The "Diagnostics" button copies a report to your clipboard. It is never sent anywhere by
  the extension; you decide whether to share it.

Permissions and why they are needed:
- `webRequest`, host access to all sites: to see the media requests a page makes, so videos on
  any site can be found.
- `downloads`: to save files.
- `offscreen`, `scripting`: to assemble and convert videos in the background and to load the
  in-page preview.
- `declarativeNetRequest`: to send the page address as the Referer header on the extension's
  own download requests, which some video hosts require.
- `storage`: to remember your presets and settings.
- `tabs`, `activeTab`, `webNavigation`: to know which tab the popup belongs to and to reset
  the detected list when you navigate.

Contact: open an issue at https://github.com/RonnieSNAFU/download-video-oss
