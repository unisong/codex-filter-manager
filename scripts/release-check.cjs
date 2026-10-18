'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8', windowsHide: true}).split('\0').filter(Boolean);
if (!files.length) throw new Error('Stage the intended public files before running release:check.');
const issues = [];
// Check what will be committed and packaged. Magpie may load magpie-workbench/ from this checkout and
// rewrite its working copy with local holds; those bytes are never staged or released.
const staged = file => execFileSync('git', ['show', ':' + file], {cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Root keeps entry points, project configuration and top-level documents only (see AGENTS.md).
const layout = {
  '': ['.gitattributes', '.github', '.gitignore', 'AGENTS.md', 'CONTRIBUTING.md', 'Diagnose.bat', 'LICENSE', 'README.md',
    'SECURITY.md', 'Start.bat', 'Status.bat', 'Stop.bat', 'THIRD_PARTY_NOTICES.md', 'docs', 'filter.cjs',
    'magpie-workbench', 'package.json', 'scripts', 'src', 'tests', 'vendor', 'web'],
  'magpie-workbench/': ['Diagnose.bat', 'LICENSE', 'Open.bat', 'README.md', 'docs', 'history', 'package.json', 'plugin',
    'server', 'test', 'tools', 'vendor', 'web', 'workbench.middleware.js']
};
for (const [prefix, allowed] of Object.entries(layout)) {
  for (const file of files.filter(name => name.startsWith(prefix))) {
    const entry = file.slice(prefix.length).split('/')[0];
    if (!allowed.includes(entry)) issues.push(file + ': not allowed in ' + (prefix || 'the repository root') + '; move it into a role directory');
  }
}
for (const file of files) {
  if (/(\.test\.[cm]?js|-check\.(py|ps1)|-smoke\.py)$/.test(file) && !/^(tests|magpie-workbench\/test)\//.test(file)) {
    issues.push(file + ': tests belong in tests/ or magpie-workbench/test/');
  }
}
const index = execFileSync('git', ['ls-files', '--stage', '-z'], {cwd: root, encoding: 'utf8', windowsHide: true}).split('\0').filter(Boolean);
for (const entry of index) if (entry.startsWith('120000 ')) issues.push(entry.split('\t')[1] + ': tracked symlink refused');
for (const file of files) {
  let candidate = path.join(root, file);
  while (candidate !== root) {
    if (fs.lstatSync(candidate).isSymbolicLink()) { issues.push(file + ': symlink path refused'); break; }
    candidate = path.dirname(candidate);
  }
  if (/(^|\/)(\.runtime|\.tools|node_modules|__pycache__|dist)(\/|$)|(^|\/)(auth\.json|config\.toml|\.env(?:\..*)?)$|\.(?:db|bak|log|previous)(?:[.-]|$)/i.test(file)) {
    issues.push(file + ': private/generated path'); continue;
  }
  if (!/\.(cjs|mjs|js|json|md|html|svg|ps1|bat|vbs|yml|py)$/.test(file)) continue;
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  if (/https:\/\/github\.com\/OWNER\//.test(content)) issues.push(file + ': unresolved repository placeholder');
  if (/[A-Z]:[\\/](?:Users[\\/](?:Administrator|ADMINI~1)|AI[\\/]ChatGPT)/i.test(content)) issues.push(file + ': personal absolute path');
  if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/.test(content)) issues.push(file + ': possible credential (contents suppressed)');
}
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'vendor/modeltrace/provenance.json'), 'utf8'));
for (const [name, info] of Object.entries(provenance.files)) {
  const actual = sha256(fs.readFileSync(path.join(root, 'vendor/modeltrace', name)));
  if (actual !== info.sha256) issues.push('vendor/modeltrace/' + name + ': provenance checksum mismatch');
  if (sha256(staged('vendor/modeltrace/' + name)) !== info.sha256) issues.push('vendor/modeltrace/' + name + ': staged bytes differ from provenance');
}
const workbenchRoot = path.join(root, 'magpie-workbench');
const workbench = JSON.parse(fs.readFileSync(path.join(workbenchRoot, 'package.json'), 'utf8'));
const product = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (workbench.version !== product.version) issues.push('magpie-workbench/package.json: version must follow the main product');
const nativePageVersion = /<span class="version">v([^<]+)<\/span>/.exec(fs.readFileSync(path.join(workbenchRoot, 'history/page/index.html'), 'utf8'))?.[1];
if (nativePageVersion !== product.version) issues.push('magpie-workbench/history/page/index.html: displayed version must follow the main product');
const workbenchProvenance = JSON.parse(fs.readFileSync(path.join(workbenchRoot, 'vendor/modeltrace/PROVENANCE.json'), 'utf8'));
for (const [name, info] of Object.entries(workbenchProvenance.files)) {
  const file = 'magpie-workbench/vendor/modeltrace/' + name;
  if (sha256(fs.readFileSync(path.join(root, file))) !== info.sha256 || sha256(staged(file)) !== info.sha256) issues.push(file + ': provenance checksum mismatch');
}
const historyProvenance = JSON.parse(fs.readFileSync(path.join(workbenchRoot, 'history/PROVENANCE.json'), 'utf8'));
if (sha256(staged('magpie-workbench/history/codex-history.middleware.js')) !== historyProvenance.sha256) {
  issues.push('magpie-workbench/history/codex-history.middleware.js: historical baseline mismatch');
}
for (const required of ['src/policy-read.cjs', 'src/updater.cjs', 'scripts/windows/install-update.ps1', 'web/assets/service-controls.js', 'magpie-workbench/server/updater.cjs', 'magpie-workbench/tools/install-update.ps1', 'magpie-workbench/web/service-controls.js', 'filter.cjs', 'src/filter.cjs', 'src/config.cjs', 'src/proxy.cjs', 'src/management.cjs', 'src/diagnostics.cjs', 'web/dashboard.html', 'Diagnose.bat', '.github/ISSUE_TEMPLATE/bug_report.yml', 'src/service-backend.cjs', 'src/history-filter.mjs', 'src/portable-web-search.mjs', 'src/guard-service.cjs', 'src/guard-evidence.cjs', 'src/guard-retry.cjs', 'src/guard.cjs', 'src/guard-transport.cjs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Start.bat', 'Stop.bat', 'Status.bat', 'scripts/windows/start.ps1', 'web/assets/app.ico', 'web/assets/favicon.svg', 'web/assets/workbench-theme.css', 'web/assets/current-selection.js', 'docs/images/providers.png', 'docs/images/protection.png', 'docs/images/history.png', 'magpie-workbench/package.json', 'magpie-workbench/README.md', 'magpie-workbench/plugin/index.mjs', 'magpie-workbench/workbench.middleware.js']) {
  if (!files.includes(required)) issues.push(required + ': required release file is not staged/tracked');
}
// Magpie loads magpie-workbench/ on its own, so these copies are intentional and must stay identical.
for (const [mainFile, mirrorFile] of [['LICENSE', 'magpie-workbench/LICENSE'],
  ['web/assets/workbench-theme.css', 'magpie-workbench/web/workbench-theme.css'],
  ['web/assets/current-selection.js', 'magpie-workbench/web/current-selection.js'],
  ['web/assets/service-controls.js', 'magpie-workbench/web/service-controls.js'],
  ['src/updater.cjs', 'magpie-workbench/server/updater.cjs'],
  ['scripts/windows/install-update.ps1', 'magpie-workbench/tools/install-update.ps1'],
  ['web/assets/favicon.svg', 'magpie-workbench/web/icon.svg'],
  ['src/guard-evidence.cjs', 'magpie-workbench/server/evidence.cjs'],
  ['src/portable-web-search.mjs', 'magpie-workbench/history/portable-web-search.mjs'],
  ['vendor/modeltrace/provenance.json', 'magpie-workbench/vendor/modeltrace/PROVENANCE.json'],
  ...['LICENSE', 'challenge-browser.mjs', 'fingerprint-core.mjs', 'unified_bank.json']
    .map(name => ['vendor/modeltrace/' + name, 'magpie-workbench/vendor/modeltrace/' + name])]) {
  if (!files.includes(mainFile) || !files.includes(mirrorFile)) continue;
  if (!staged(mainFile).equals(staged(mirrorFile))) {
    issues.push(mainFile + ' and ' + mirrorFile + ': shared copies must be byte-identical');
  }
}
import(pathToFileURL(path.join(workbenchRoot, 'server/middleware.mjs')).href).then(({combineMiddleware}) => {
  const publicEntry = combineMiddleware();
  const file = 'magpie-workbench/workbench.middleware.js';
  if (staged(file).toString('utf8') !== publicEntry) {
    issues.push(file + ': staged entry must equal tools/build-middleware.mjs output (no private holds)');
  }
  const local = fs.readFileSync(path.join(root, file), 'utf8') !== publicEntry;
  if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
  else console.log(JSON.stringify({passed: true, publicFiles: files.length, layout: 'verified', modelTraceProvenance: 'verified',
    workbench: 'staged public entry verified' + (local ? '; working copy holds local Magpie state and is not staged' : ''),
    note: 'Heuristic checks supplement manual review; they are not a complete secret audit.'}));
}).catch(() => { console.error('magpie-workbench: public source validation failed'); process.exitCode = 1; });
