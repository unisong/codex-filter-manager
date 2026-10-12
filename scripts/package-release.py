"""Package only reviewed Git-tracked files; private runtime is never included."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
subprocess.run(['node', 'scripts/release-check.cjs'], cwd=root, check=True)
files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode('utf-8').split('\0')
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
name = f'codex-filter-manager-v{version}-windows'
output = root / 'dist'
output.mkdir(exist_ok=True)
archive = output / f'{name}.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
    for file in sorted(filter(None, files)):
        source = root / file
        resolved = source.resolve()
        if source.is_symlink() or any(parent.is_symlink() for parent in source.parents if parent != root and root in parent.parents) or root not in resolved.parents:
            raise RuntimeError('Unexpected path in release input')
        package.write(resolved, f'{name}/{file}')
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(output / 'SHA256SUMS.txt').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
print(json.dumps({'archive': str(archive), 'sha256': digest, 'files': len([f for f in files if f])}))
