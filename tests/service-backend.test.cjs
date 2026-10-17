'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {detectBackend, serviceBackend} = require('../src/service-backend.cjs');
const {parseArgs, start, serve} = require('../src/filter.cjs');

function fixture(t) {
  const parent = fs.realpathSync(process.env.PI_SCRATCH_DIR);
  const directory = fs.mkdtempSync(path.join(parent, 'backend-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const configPath = path.join(directory, 'config.toml');
  const runtime = path.join(directory, 'runtime');
  fs.writeFileSync(path.join(directory, 'settings.json'), '{"port":3425}');
  return {directory, configPath, runtime, magpieDirectory: directory};
}
test('removed Magpie service flags direct users to the complete workbench', () => {
  assert.throws(() => parseArgs(['start', '--backend', 'magpie']), /magpie-workbench.*base_url/);
  assert.throws(() => parseArgs(['start', '--magpie-dir', 'unused']), /Invalid option/);
});
test('Magpie config cannot start either service path or register a legacy hook, including explicit CCS override', async t => {
  const f = fixture(t);
  const original = 'model_provider="magpie"\n[model_providers.magpie]\nbase_url="http://127.0.0.1:3425/v1"\n';
  const pluginsPath = path.join(f.directory, 'plugins.json');
  fs.writeFileSync(f.configPath, original);
  fs.writeFileSync(pluginsPath, '{"plugins":[{"spec":"existing-plugin"}]}');
  const before = fs.readFileSync(pluginsPath, 'utf8');
  const options = {...parseArgs(['start', '--config', f.configPath, '--runtime', f.runtime]), magpieDirectory: f.directory};
  assert.equal(detectBackend(options), 'magpie');
  for (const backend of ['auto', 'ccswitch']) {
    await assert.rejects(start({...options, backend}), /magpie-workbench/);
    await assert.rejects(serve({...options, backend}), /magpie-workbench/);
  }
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  assert.equal(fs.readFileSync(pluginsPath, 'utf8'), before);
  assert.equal(fs.existsSync(f.runtime), false, 'rejected startup created service state');
});
test('custom Magpie provider names and old redirected routes are also recognized without writes', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'settings.json'), '{"port":43210}');
  const original = 'model_provider="custom"\n[model_providers.custom]\nbase_url="http://127.0.0.1:43210/v1"\n';
  fs.writeFileSync(f.configPath, original);
  assert.throws(() => serviceBackend(f), /magpie-workbench/);
  fs.mkdirSync(f.runtime);
  fs.writeFileSync(f.configPath, original.replace('43210', '18181'));
  fs.writeFileSync(path.join(f.runtime, 'routes.json'), JSON.stringify({routes: [['custom', {originalUrl: 'http://127.0.0.1:43210/v1'}]]}));
  assert.equal(detectBackend(f), 'magpie');
  assert.throws(() => serviceBackend(f), /magpie-workbench/);
});
test('CC Switch service selection remains available', t => {
  const f = fixture(t);
  fs.writeFileSync(f.configPath, 'model_provider="custom"\n[model_providers.custom]\nbase_url="http://127.0.0.1:15721/v1"\n');
  assert.equal(serviceBackend(f), 'ccswitch');
});
