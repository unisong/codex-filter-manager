"""Exercise the Windows installer with disposable releases, never the live service."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import zipfile

root = Path(__file__).resolve().parent.parent
helper = root / 'scripts/windows/install-update.ps1'
node = shutil.which('node')
if os.name != 'nt':
    raise SystemExit('Windows installer checks require Windows.')

old_entry = '''const fs=require('node:fs');
fs.appendFileSync(require('node:path').join(__dirname,'.runtime','calls.txt'),process.argv[2]+'\\n');
console.log(JSON.stringify({running:process.argv[2]==='start',state:process.argv[2]==='start'?'running':'stopped'}));
'''
new_entry = old_entry.replace("console.log", "if(process.argv[2]==='start'&&fs.existsSync(require('node:path').join(__dirname,'fail-start')))process.exit(1);\nconsole.log")
required = ['src/filter.cjs', 'scripts/windows/start.ps1', 'web/dashboard.html',
            'magpie-workbench/plugin/index.mjs', 'magpie-workbench/workbench.middleware.js']

with tempfile.TemporaryDirectory(prefix='filter-update-install-') as scratch:
    for scenario in ['install', 'install-custom', 'background', 'rollback', 'traversal', 'checksum', 'magpie']:
        base = Path(scratch) / scenario
        install = base / 'installed space \u4e2d\u6587'
        data = install / '.runtime'
        job = (base / 'downloads 中文' / 'offline-job') if scenario == 'install-custom' else (data / 'updates' / 'offline-job')
        job.mkdir(parents=True)
        install.mkdir(parents=True, exist_ok=True)
        data.mkdir(parents=True, exist_ok=True)
        (install / 'filter.cjs').write_text(old_entry, encoding='utf-8')
        (install / 'package.json').write_text('{"version":"1.0.9"}', encoding='utf-8')
        (data / 'provider-rules.json').write_text('{"private":"unchanged"}', encoding='utf-8')
        private_bytes = (data / 'provider-rules.json').read_bytes()
        if scenario == 'rollback':
            (install / 'fail-start').write_text('test-only')
        archive = job / 'release.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            prefix = 'codex-filter-manager-v1.2.0-windows/'
            z.writestr(prefix + 'filter.cjs', new_entry)
            for name in ['package.json', 'magpie-workbench/package.json']:
                z.writestr(prefix + name, '{"version":"1.2.0"}')
            for name in required:
                z.writestr(prefix + name, 'offline-fixture')
            if scenario == 'traversal':
                z.writestr(prefix + '../escaped.txt', 'must never be written')
        result = data / 'update-result.json'
        plan = dict(root=str(install), job=str(job), mode='magpie' if scenario == 'magpie' else 'ccswitch',
                    tag='v1.2.0', archive=str(archive), sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
                    resultFile=str(result), restart=[], node=node)
        if scenario == 'checksum':
            plan['sha256'] = '0' * 64
        plan_file = job / 'plan.json'
        plan_file.write_text(json.dumps(plan), encoding='utf-8')
        if scenario == 'background':
            # Exercise the production launcher, including parent exit. A direct
            # PowerShell invocation cannot detect broken detached spawn flags.
            script = r'''
const fs=require('node:fs'),path=require('node:path');
const {createUpdater}=require(process.argv[1]);
const plan=JSON.parse(fs.readFileSync(process.argv[2]));
const name='codex-filter-manager-v1.2.0-windows.zip', bytes=fs.readFileSync(plan.archive);
const asset=n=>({name:n,size:bytes.length,browser_download_url:'https://github.com/unisong/codex-filter-manager/releases/download/v1.2.0/'+n});
(async()=>{
 const updater=createUpdater({root:plan.root,directory:path.dirname(plan.resultFile),currentVersion:'1.0.9',
  helper:process.argv[3],restart:[],fetcher:async url=>new Response(url.includes('api.github.com')
   ? JSON.stringify([{tag_name:'v1.2.0',assets:[asset(name),asset('SHA256SUMS.txt')]}])
   : url.endsWith('SHA256SUMS.txt')?plan.sha256+'  '+name:bytes)});
 await updater.check();updater.install('v1.2.0');await updater.settle();
 if(updater.snapshot().error)throw Error(updater.snapshot().error);
})().catch(e=>{console.error(e.message);process.exitCode=1});
'''
            command = [node, '-e', script, str(root / 'src/updater.cjs'), str(plan_file), str(helper)]
        else:
            command = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                       '-File', str(helper), '-Plan', str(plan_file)]
        process = subprocess.run(command, capture_output=True, text=True, timeout=60,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        if scenario == 'background':
            assert process.returncode == 0, process.stderr
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    if json.loads(result.read_text(encoding='utf-8'))['phase'] in ['installed', 'failed']:
                        # Terminal state is written immediately before the helper
                        # releases its lock. Wait before cleaning the fixture.
                        with (data / 'update.lock').open('rb'):
                            break
                except (FileNotFoundError, PermissionError):
                    pass
                time.sleep(0.1)
        output = json.loads(result.read_text(encoding='utf-8'))
        assert (data / 'provider-rules.json').read_bytes() == private_bytes
        if scenario in ['install', 'install-custom', 'background']:
            assert process.returncode == 0 and output['phase'] == 'installed', output
            assert json.loads((install / 'package.json').read_text())['version'] == '1.2.0'
            backups = list(job.parent.glob('*/backup/filter.cjs'))
            assert len(backups) == 1 and backups[0].read_text() == old_entry
        elif scenario == 'magpie':
            assert process.returncode == 0 and output['phase'] == 'ready', output
            assert Path(output['target']).is_dir()
            assert json.loads((install / 'package.json').read_text())['version'] == '1.0.9'
            assert not (data / 'calls.txt').exists(), 'Magpie must not be stopped'
        else:
            assert process.returncode != 0 and output['phase'] == 'failed', output
            assert (install / 'filter.cjs').read_text() == old_entry
            if scenario == 'rollback':
                assert 'Previous files restored' in output['message'], output
                assert (data / 'calls.txt').read_text().splitlines() == ['stop', 'start', 'stop', 'start']
            else:
                assert not (data / 'calls.txt').exists(), 'Invalid packages must not stop the service'
            assert not (job / 'escaped.txt').exists()
        print(scenario + ': passed')
