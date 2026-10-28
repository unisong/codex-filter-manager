import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {diagnose} from '../tools/diagnose.mjs';
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'magpie-diag-'));
  const config = path.join(directory, 'fixture.toml');
  fs.writeFileSync(config, 'model_provider="magpie"\nmodel="private-id/gpt-private"\n[model_providers.magpie]\nbase_url="http://127.0.0.1:3425/v1"\nexperimental_bearer_token="PRIVATE_KEY"\n');
  const entry = {spec: '@magpie-community/middleware-codex-history', options: {providers: {'magpie:private-id': {historyFilter: true, preserveEncryptedInclude: true}}, aliases: {}}};
  const save = entries => fs.writeFileSync(path.join(directory, 'plugins.json'), JSON.stringify({plugins: entries, private: 'PRIVATE_BODY'}));
  save([entry]);
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), parent); fs.rmSync(directory, {recursive: true, force: true}); });
  return {directory, config, entry, save, probe: async port => { assert.equal(port, 3425); return true; }};
}
test('Magpie read-only diagnosis is private and never confuses config with runtime proof', async t => {
  const f = fixture(t), before = fs.readFileSync(f.config);
  const pluginsBefore = fs.readFileSync(path.join(f.directory, 'plugins.json'));
  const report = await diagnose(f);
  assert.equal(report.configuration.codexBaseMatchesLocalMagpie, true);
  assert.equal(report.plugins[0].selectedRule, 'enabled'); assert.equal(report.observation.runtimeCalls, null);
  assert.ok(report.checks.some(c => c.code === 'runtime-unobserved'));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|private-id|gpt-private|3425|fixture\.toml/);
  assert.deepEqual(fs.readFileSync(f.config), before); assert.deepEqual(fs.readFileSync(path.join(f.directory, 'plugins.json')), pluginsBefore);
  f.entry.spec += '@latest'; f.save([f.entry]); assert.equal((await diagnose(f)).plugins[0].source, 'community');
});
test('Magpie diagnosis detects disabled, duplicate, wrong model and bad rules', async t => {
  const f = fixture(t);
  f.entry.off = true; f.save([f.entry]); assert.ok((await diagnose(f)).checks.some(c => c.code === 'filter-disabled'));
  delete f.entry.off; f.save([f.entry, {...f.entry, spec: 'github:unisong/magpie-codex-history-filter#v0.1.0'}]);
  assert.ok((await diagnose(f)).checks.some(c => c.code === 'duplicate-filters'));
  assert.equal((await diagnose({...f, model: 'other/model'})).plugins[0].selectedRule, 'not-configured');
  assert.equal((await diagnose({...f, model: 'bare'})).plugins[0].selectedRule, 'no-provider-prefix');
  f.entry.options.providers = []; f.save([f.entry]); assert.ok((await diagnose(f)).checks.some(c => c.code === 'invalid-provider-rules'));
  f.entry.options.providers = {'magpie:private-id': {historyFilter: 'true'}}; f.entry.options.aliases = [];
  f.save([f.entry]); const invalid = await diagnose(f);
  assert.ok(invalid.checks.some(c => c.code === 'invalid-rule-fields')); assert.ok(invalid.checks.some(c => c.code === 'invalid-aliases'));
});
test('aliases match actual model while local filter copies and custom gateway are recognized', async t => {
  const f = fixture(t);
  f.entry.spec = path.join(f.directory, 'magpie-plugin'); f.entry.options.aliases.old = 'private-id'; f.save([f.entry]);
  assert.equal((await diagnose({...f, model: 'old/model'})).plugins[0].selectedRule, 'enabled');
  fs.writeFileSync(path.join(f.directory, 'settings.json'), '{"port":12345}');
  fs.writeFileSync(path.join(f.directory, 'plugins.yml'), 'middleware: false\n');
  const report = await diagnose({...f, probe: async port => { assert.equal(port, 12345); return false; }});
  assert.equal(report.configuration.codexBaseMatchesLocalMagpie, false);
  assert.ok(report.checks.some(c => c.code === 'gateway-not-listening'));
  assert.ok(report.checks.some(c => c.code === 'builtin-middleware-off'));
});
test('unknown/missing configs and invalid settings are reported without leaking raw parse errors', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.directory, 'plugins.json'), 'PRIVATE_INVALID');
  fs.writeFileSync(path.join(f.directory, 'settings.json'), '{"port":"PRIVATE_INVALID"}');
  fs.unlinkSync(f.config);
  const report = await diagnose({...f, probe: () => assert.fail('invalid port must not be probed')});
  assert.ok(report.checks.some(c => c.code === 'plugins-unreadable'));
  assert.ok(report.checks.some(c => c.code === 'settings-unreadable'));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_INVALID/);
});
test('CLI refuses overwriting an existing output file, including the Codex config', t => {
  const f = fixture(t), before = fs.readFileSync(f.config);
  const result = spawnSync(process.execPath, ['tools/diagnose.mjs', '--magpie-dir', f.directory, '--config', f.config, '--output', f.config], {cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 1); assert.deepEqual(fs.readFileSync(f.config), before);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_KEY|private-id|fixture\.toml/);
});
test('Windows one-click exporter preserves UTF-8 JSON through PowerShell 5.1', {skip: process.platform !== 'win32', timeout: 20000}, t => {
  const f = fixture(t), app = path.join(f.directory, 'app'), tools = path.join(app, 'tools'); fs.mkdirSync(tools, {recursive: true});
  for (const name of ['diagnose.ps1', 'diagnose.mjs']) fs.copyFileSync(new URL('../tools/' + name, import.meta.url), path.join(tools, name));
  fs.copyFileSync(new URL('../package.json', import.meta.url), path.join(app, 'package.json'));
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'diagnose.ps1'), '-MagpieDir', f.directory, '-Config', f.config],
    {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stderr);
  const files = fs.readdirSync(path.join(app, '.runtime', 'reports')); assert.equal(files.length, 1);
  const report = JSON.parse(fs.readFileSync(path.join(app, '.runtime', 'reports', files[0]), 'utf8'));
  assert.equal(report.plugins[0].selectedRule, 'enabled');
  assert.match(report.checks[0].message, /所选配置地址/); assert.doesNotMatch(JSON.stringify(report), /\uFFFD/);
});
