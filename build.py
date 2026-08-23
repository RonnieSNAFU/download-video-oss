"""Builds dist/download-video-oss-<version>.zip for the Chrome Web Store."""
import json, os, zipfile
os.chdir(os.path.dirname(os.path.abspath(__file__)))
v = json.load(open('manifest.json'))['version']
os.makedirs('dist', exist_ok=True)
out = f'dist/download-video-oss-{v}.zip'
files = ['manifest.json', 'background.js', 'offscreen.html', 'offscreen.js', 'clip.js', 'wc.js', 'webm.js', 'mp4fix.js', 'mux.min.js', 'popup.html', 'popup.js', 'LICENSE', 'LICENSE-mux.txt']
dirs = ['core', 'sites', 'icons', 'vendor']
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files: z.write(f)
    for d in dirs:
        for root, _, names in os.walk(d):
            for n in names:
                if not n.endswith('.map'): z.write(os.path.join(root, n))
print(out, f'{os.path.getsize(out) / 1048576:.1f} MB')
