'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const project = path.resolve(__dirname, '..');
const temporaryRoot = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(temporaryRoot, 'codex-filter-tests-'));
try {
  const tests = fs.readdirSync(project).filter(name => name.endsWith('.test.cjs')).sort();
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: project, stdio: 'inherit', windowsHide: true,
    env: {...process.env, PI_SCRATCH_DIR: scratch}
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const resolved = fs.realpathSync(scratch);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('codex-filter-tests-')) {
    throw new Error('Unexpected test scratch directory; cleanup refused.');
  }
  fs.rmSync(resolved, {recursive: true, force: true});
}
