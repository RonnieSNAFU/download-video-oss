"""Builds dist/download-video-oss-<version>.zip for the Chrome Web Store.

Everything in the folder ships except development files, so a new file can never be left out of the
package by accident. The result is then checked: every path the manifest and the HTML pages refer to
must exist inside the zip, or the build fails.
"""
import json, os, re, sys, zipfile

os.chdir(os.path.dirname(os.path.abspath(__file__)))

SKIP_DIRS = {'.git', 'dist', 'store', 'node_modules', '__pycache__'}
SKIP_FILES = {'build.py', 'README.md', 'PRIVACY.md', '.gitignore'}
SKIP_EXT = {'.zip', '.py', '.map', '.md'}

def collect():
    out = []
    for root, dirs, names in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith('.')]
        for n in names:
            if n in SKIP_FILES or os.path.splitext(n)[1].lower() in SKIP_EXT:
                continue
            p = os.path.relpath(os.path.join(root, n), '.').replace('\\', '/')
            if p.startswith('.'):
                continue
            out.append(p)
    return sorted(out)

def referenced(manifest, files, read):
    """Every path the extension points at, from the manifest and from its HTML pages."""
    refs = set()
    for cs in manifest.get('content_scripts', []):
        refs.update(cs.get('js', []) + cs.get('css', []))
    bg = manifest.get('background', {}).get('service_worker')
    if bg:
        refs.add(bg)
    popup = manifest.get('action', {}).get('default_popup')
    if popup:
        refs.add(popup)
    refs.update(manifest.get('icons', {}).values())
    refs.update(manifest.get('action', {}).get('default_icon', {}).values())
    for war in manifest.get('web_accessible_resources', []):
        refs.update(war.get('resources', []))
    # scripts and stylesheets inside the packaged pages, resolved against the page's folder
    for page in [f for f in files if f.endswith('.html')]:
        base = os.path.dirname(page)
        for m in re.finditer(r'(?:src|href)\s*=\s*["\']([^"\':#?]+)["\']', read(page)):
            src = m.group(1)
            if src.startswith(('http', '//', 'data:', 'chrome')):
                continue
            refs.add(os.path.normpath(os.path.join(base, src)).replace('\\', '/'))
    return refs

files = collect()
manifest = json.load(open('manifest.json', encoding='utf-8'))
version = manifest['version']
read = lambda p: open(p, encoding='utf-8', errors='ignore').read()

missing = sorted(r for r in referenced(manifest, files, read) if r not in files)
if missing:
    sys.exit(f'build failed: these are referenced but would not be packaged: {missing}')

os.makedirs('dist', exist_ok=True)
out = f'dist/download-video-oss-{version}.zip'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f)

# read the finished package back and confirm it holds what it should
with zipfile.ZipFile(out) as z:
    packed = set(z.namelist())
    m2 = json.loads(z.read('manifest.json'))
    gone = sorted(r for r in referenced(m2, [p for p in packed if p.endswith('.html')], lambda p: z.read(p).decode('utf-8', 'ignore')) if r not in packed)
    if gone:
        sys.exit(f'build failed: missing from the package: {gone}')

print(f'{out}  {os.path.getsize(out) / 1048576:.1f} MB  {len(files)} files')
