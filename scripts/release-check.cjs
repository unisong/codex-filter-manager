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
  const actual = createHash('sha256').update(fs.readFileSync(path.join(root, 'vendor/modeltrace', name))).digest('hex');
  if (actual !== info.sha256) issues.push('vendor/modeltrace/' + name + ': provenance checksum mismatch');
  const staged = execFileSync('git', ['show', ':vendor/modeltrace/' + name], {cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  if (createHash('sha256').update(staged).digest('hex') !== info.sha256) issues.push('vendor/modeltrace/' + name + ': staged bytes differ from provenance');
}
const workbenchRoot = path.join(root, 'magpie-workbench');
const workbench = JSON.parse(fs.readFileSync(path.join(workbenchRoot, 'package.json'), 'utf8'));
const product = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (workbench.version !== product.version) issues.push('magpie-workbench/package.json: version must follow the main product');
const workbenchProvenance = JSON.parse(fs.readFileSync(path.join(workbenchRoot, 'vendor/modeltrace/PROVENANCE.json'), 'utf8'));
for (const [name, info] of Object.entries(workbenchProvenance.files)) {
  const file = 'magpie-workbench/vendor/modeltrace/' + name;
  const actual = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  const staged = execFileSync('git', ['show', ':' + file], {cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  if (actual !== info.sha256 || createHash('sha256').update(staged).digest('hex') !== info.sha256) issues.push(file + ': provenance checksum mismatch');
}
const historyProvenance = JSON.parse(fs.readFileSync(path.join(workbenchRoot, 'history/PROVENANCE.json'), 'utf8'));
for (const file of ['magpie-workbench/codex-history.middleware.js', 'magpie-workbench/history/codex-history.middleware.js']) {
  if (createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') !== historyProvenance.sha256) issues.push(file + ': historical baseline mismatch');
}
for (const required of ['filter.cjs', 'src/filter.cjs', 'src/config.cjs', 'src/proxy.cjs', 'src/management.cjs', 'src/diagnostics.cjs', 'web/dashboard.html', 'Diagnose.bat', '.github/ISSUE_TEMPLATE/bug_report.yml', 'src/magpie.cjs', 'src/magpie-plugin-store.cjs', 'magpie-plugin/package.json', 'magpie-plugin/history.middleware.js', 'magpie-plugin/history-filter.mjs', 'magpie-plugin/portable-web-search.mjs', 'src/guard-service.cjs', 'src/guard-evidence.cjs', 'src/guard-retry.cjs', 'src/guard.cjs', 'src/guard-transport.cjs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Start.bat', 'Stop.bat', 'Status.bat', 'start.ps1', 'assets/app.ico', 'assets/favicon.svg', 'assets/workbench-theme.css', 'assets/current-selection.js', 'docs/images/providers.png', 'docs/images/protection.png', 'docs/images/history.png', 'magpie-workbench/package.json', 'magpie-workbench/README.md', 'magpie-workbench/plugin/index.mjs', 'magpie-workbench/workbench.middleware.js']) {
  if (!files.includes(required)) issues.push(required + ': required release file is not staged/tracked');
}
import(pathToFileURL(path.join(workbenchRoot, 'server/middleware.mjs')).href).then(({combineMiddleware}) => {
  if (fs.readFileSync(path.join(workbenchRoot, 'workbench.middleware.js'), 'utf8') !== combineMiddleware()) {
    issues.push('magpie-workbench/workbench.middleware.js: rebuild the public entry without private holds');
  }
  if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
  else console.log(JSON.stringify({passed: true, publicFiles: files.length, modelTraceProvenance: 'verified', workbench: 'public source verified', note: 'Heuristic checks supplement manual review; they are not a complete secret audit.'}));
}).catch(() => { console.error('magpie-workbench: public source validation failed'); process.exitCode = 1; });
