"""Package the committed HEAD tree only.

Working-tree bytes are never read: Magpie can rewrite the checked-out workbench middleware with
local holds and probe credentials, and editors may leave other files changed or with mixed line
endings. Files are taken from HEAD with the same .gitattributes conversion as a fresh checkout.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import time
import zipfile

root = Path(__file__).resolve().parent.parent
git = lambda *args: subprocess.check_output(['git', *args], cwd=root)
if git('diff', '--cached', '--name-only', 'HEAD'):
    raise SystemExit('Commit or unstage the staged changes first; the release is built from HEAD only.')
subprocess.run(['node', 'scripts/release-check.cjs'], cwd=root, check=True)
files = [f for f in git('ls-tree', '-r', '-z', '--name-only', 'HEAD').decode('utf-8').split('\0') if f]
version = json.loads(git('show', 'HEAD:package.json'))['version']
name = f'codex-filter-manager-v{version}-windows'
output = root / 'dist'
output.mkdir(exist_ok=True)
archive = output / f'{name}.zip'
stamp = time.localtime(int(git('log', '-1', '--format=%ct', 'HEAD')))[:6]
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
    for file in sorted(files):
        if file.startswith('/') or '..' in file.split('/'):
            raise RuntimeError('Unexpected path in release input')
        data = git('cat-file', '--filters', f'HEAD:{file}')
        if file.endswith('workbench.middleware.js') and b'// Generated locally.' in data:
            raise RuntimeError(file + ': committed copy contains local Magpie state')
        info = zipfile.ZipInfo(f'{name}/{file}', date_time=stamp)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        package.writestr(info, data, compresslevel=9)
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(output / 'SHA256SUMS.txt').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
print(json.dumps({'archive': str(archive), 'sha256': digest, 'files': len(files), 'source': git('rev-parse', 'HEAD').decode().strip()}))
