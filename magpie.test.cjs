'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const {createMagpieAdapter, detectBackend, discoverMagpie} = require('./magpie.cjs');
const {ConfigRouter, providerBase} = require('./config.cjs');
const {createManagement} = require('./management.cjs');
const {createGuardService} = require('./guard-service.cjs');
const {probe, collectResponse} = require('./guard-transport.cjs');
const {makeProxy} = require('./proxy.cjs');
const {Readable} = require('node:stream');
const {parseArgs, start, stop} = require('./filter.cjs');

function fixture(t) {
  const parent = fs.realpathSync(process.env.PI_SCRATCH_DIR);
  const runtime = fs.mkdtempSync(path.join(parent, 'magpie-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(runtime)), parent);
    fs.rmSync(runtime, {recursive: true, force: true});
  });
  const configPath = path.join(runtime, 'config.toml');
  const text = 'model="one/gpt-6-astra"\nmodel_provider="magpie"\n[model_providers.magpie]\nbase_url="http://127.0.0.1:3425/v1"\n[model_providers.custom]\nbase_url="http://127.0.0.1:3425/v1"\n[model_providers.remote]\nbase_url="https://example.invalid/v1"\n';
  fs.writeFileSync(configPath, text);
  const data = {noAutoGroups: true, providers: [
    {id: 'one', name: 'One', responses: 'https://one.invalid/v1', key: 'PRIVATE_KEY_ONE', was: ['old-one'], models: ['gpt-6-astra']},
    {id: 'two', name: 'Two', responses: 'https://two.invalid/v1', key: 'PRIVATE_KEY_TWO', models: ['gpt-6-astra']}
  ]};
  const save = () => fs.writeFileSync(path.join(runtime, 'providers.json'), JSON.stringify(data));
  save();
  const adapter = createMagpieAdapter({directory: runtime, configPath, getUpstream: () => 'http://127.0.0.1:3425'});
  return {runtime, configPath, adapter, data, save, text};
}
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function send(origin, model, extra = {}, compact = false) {
  const raw = zlib.gzipSync(JSON.stringify({model, input: [{type: 'reasoning', encrypted_content: 'old'}, {role: 'user', content: 'hello'}]}));
  return new Promise((resolve, reject) => {
    const req = http.request(origin + '/v1/responses' + (compact ? '/compact' : ''), {method: 'POST', headers: {'content-encoding': 'gzip', 'content-length': raw.length, ...extra}}, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({status: res.statusCode, body}));
    });
    req.on('error', reject); req.end(raw);
  });
}

test('Magpie auto detection, default-off rules, namespaced IDs and secret-safe state', t => {
  const f = fixture(t);
  assert.equal(detectBackend({...f, magpieDirectory: f.runtime}), 'magpie');
  assert.equal(detectBackend({...f, backend: 'ccswitch'}), 'ccswitch');
  assert.equal(discoverMagpie(f.runtime), 'http://127.0.0.1:3425');
  const manager = createManagement({runtime: f.runtime, adapter: f.adapter});
  const initial = manager.state();
  assert.equal(initial.providers[0].id, 'magpie:one');
  assert.ok(initial.providers.every(p => !p.rule.historyFilter));
  manager.handle('PUT', '/providers/magpie:one/rule', {revision: initial.revision,
    rule: {historyFilter: true, preserveEncryptedInclude: true, stripResponsesLiteHeader: false}});
  assert.equal(manager.policy({model: 'one/gpt-6-astra'}).filter, true);
  assert.equal(manager.policy({model: 'two/gpt-6-astra'}).filter, false);
  assert.equal(manager.policy({model: 'old-one/gpt-6-astra'}).filter, true);
  assert.equal(manager.policy({}).filter, false);
  assert.doesNotMatch(JSON.stringify(manager.state()), /PRIVATE_KEY/);
  assert.throws(() => manager.handle('PUT', '/aliases', {enabled: true}), {code: 'aliases_unavailable'});
});

test('Magpie rejects ambiguous routing and invalidates fingerprints on key or plugin changes', t => {
  const f = fixture(t), before = f.adapter.route();
  assert.equal(before.model, 'gpt-6-astra');
  assert.equal(f.adapter.route('gpt-6-astra').available, false);
  assert.equal(f.adapter.route('unknown/gpt-6-astra').available, false);
  f.data.providers[0].key = 'CHANGED_PRIVATE_KEY'; f.save();
  assert.notEqual(f.adapter.route().digest, before.digest);
  f.data.providers[0].fallback = ['two/gpt-6-astra']; f.save();
  assert.match(f.adapter.route().reason, /fallback/);
  delete f.data.providers[0].fallback; f.save();
  fs.writeFileSync(path.join(f.runtime, 'plugins.yml'), '# built-in\npreset: all\n');
  assert.equal(f.adapter.route().available, true);
  fs.writeFileSync(path.join(f.runtime, 'plugins.yml'), 'plugins:\n  - spec: custom.js\n');
  assert.match(f.adapter.route().reason, /插件/);
  fs.writeFileSync(path.join(f.runtime, 'providers.json'), '{invalid');
  assert.equal(f.adapter.route().available, false);
});

test('Magpie history filtering uses each uploaded model, preserves compressed passthrough and blocks its compact route', async t => {
  const f = fixture(t), seen = [];
  const upstream = await listen(t, http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = Buffer.concat(chunks), gzip = req.headers['content-encoding'] === 'gzip';
    seen.push({gzip, input: JSON.parse((gzip ? zlib.gunzipSync(body) : body).toString())});
    res.end('{}');
  }));
  const rules = {'magpie:one': {historyFilter: true, preserveEncryptedInclude: true, stripResponsesLiteHeader: false}};
  const origin = await listen(t, makeProxy({getUpstream: () => upstream, requestScopedPolicy: true,
    getFilterPolicy: input => f.adapter.policy(rules, input)}));
  const replies = await Promise.all([send(origin, 'two/gpt-6-astra'), send(origin, 'one/gpt-6-astra')]);
  assert.ok(replies.every(r => r.status === 200));
  const one = seen.find(r => r.input.model.startsWith('one/')), two = seen.find(r => r.input.model.startsWith('two/'));
  assert.equal(one.gzip, false); assert.equal(one.input.input.length, 1);
  assert.equal(two.gzip, true); assert.equal(two.input.input.length, 2);
  assert.equal((await send(origin, 'one/gpt-6-astra', {}, true)).status, 409);
  assert.equal((await send(origin, 'two/gpt-6-astra', {}, true)).status, 200);
});

test('Magpie protected concurrent routes retain independent contexts and manual probes preserve the provider prefix', async t => {
  const f = fixture(t), checks = [], invalidated = [];
  const engine = {snapshot: () => ({providers: {'magpie:one': {enabled: true}, 'magpie:two': {enabled: true}}, records: []}),
    policy: () => ({enabled: true}), invalidate: id => invalidated.push(id), assertAllowed() {}, ensure: async context => checks.push(context)};
  const guard = createGuardService({...f, adapter: f.adapter, getUpstream: () => 'http://127.0.0.1:3425', engineFactory: () => engine});
  const transport = {upstream: 'http://127.0.0.1:3425', path: '/v1/responses', headers: {authorization: 'Bearer MEMORY_ONLY'}};
  const one = await guard.prepare({model: 'one/gpt-6-astra'}, transport);
  const two = await guard.prepare({model: 'two/gpt-6-astra'}, transport);
  guard.assertCurrent(one); guard.assertCurrent(two);
  assert.notEqual(one.key, two.key); assert.equal(one.model, 'gpt-6-astra');
  assert.equal(one.requestModel, 'one/gpt-6-astra'); assert.equal(invalidated.length, 0);
  guard.check({providerId: 'magpie:one', model: 'gpt-6-luna'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks.at(-1).requestModel, 'one/gpt-6-luna');
  assert.throws(() => guard.check({providerId: 'magpie:one', model: 'two/gpt-6-astra'}), /当前 Magpie 供应商/);
  await assert.rejects(guard.prepare({model: 'gpt-6-astra'}, transport), {code: 'guard_unverified'});
  f.data.providers[0].key = 'NEW_PRIVATE_KEY'; f.save();
  assert.throws(() => guard.assertCurrent(one), {code: 'guard_unverified'});
  assert.doesNotMatch(JSON.stringify(guard.snapshot()), /MEMORY_ONLY|PRIVATE_KEY/);
});

test('Magpie probe transports prefixed model and strictly validates actual provider/model metadata', async t => {
  let payload;
  const upstream = await listen(t, http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; payload = JSON.parse(body);
    res.writeHead(200, {'content-type': 'application/json', 'x-magpie-provider': 'one', 'x-magpie-model': 'one/gpt-6-astra'});
    res.end(JSON.stringify({status: 'completed', model: 'gpt-6-astra', output: [{type: 'message', content: [{type: 'output_text', text: '1,2,3'}]}]}));
  }));
  const result = await probe({context: {model: 'gpt-6-astra', requestModel: 'one/gpt-6-astra', gatewayProvider: 'one',
    transport: {upstream, path: '/v1/responses', headers: {}}}, prompt: 'test'});
  assert.equal(payload.model, 'one/gpt-6-astra'); assert.equal(result.model, 'gpt-6-astra');
  for (const headers of [{}, {'x-magpie-provider': 'two', 'x-magpie-model': 'two/gpt-6-astra'},
    {'x-magpie-provider': 'one', 'x-magpie-model': 'one/gpt-6-luna'}]) {
    const response = Readable.from([Buffer.from(JSON.stringify({model: 'gpt-6-astra', status: 'completed', output: []}))]);
    response.headers = {'content-type': 'application/json', ...headers};
    await assert.rejects(collectResponse(response, {expectedModel: 'gpt-6-astra', expectedProvider: 'one'}), {code: 'guard_unverified'});
  }
});

test('Magpie routing stays byte-for-byte unchanged during sync and stale-backup restore', t => {
  const f = fixture(t);
  const backupPath = path.join(f.runtime, 'routes.json');
  // Even a stale CC Switch backup must never be restored in Magpie mode.
  const stale = JSON.stringify({version: 1, configPath: f.configPath, filterOrigin: 'http://127.0.0.1:18181',
    routes: [['magpie', {originalUrl: 'http://127.0.0.1:15721/v1', filteredUrl: 'http://127.0.0.1:18181/v1'}]]});
  fs.writeFileSync(backupPath, stale);
  const router = new ConfigRouter({configPath: f.configPath, backupPath,
    filterOrigin: 'http://127.0.0.1:18181', getUpstream: () => 'http://127.0.0.1:3425', backend: 'magpie'});
  router.sync(); router.sync(); router.restore();
  assert.equal(router.state, 'magpie-plugin');
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), f.text);
  assert.equal(fs.readFileSync(backupPath, 'utf8'), stale);
  assert.equal(providerBase(f.text, 'custom').url, 'http://127.0.0.1:3425/v1');
});

test('old CC Switch protection cannot enable Magpie protection; a protected response cannot hide a different gateway route', async t => {
  const f = fixture(t);
  const old = createGuardService({...f, adapter: f.adapter, getUpstream: () => 'http://127.0.0.1:3425'});
  old.configure('old-ccswitch-id', {enabled: true, ttlSeconds: 1800});
  assert.equal(old.shouldInspect(), false);
  const upstream = await listen(t, http.createServer((req, res) => {
    res.writeHead(200, {'content-type': 'application/json', 'x-magpie-provider': 'two', 'x-magpie-model': 'two/gpt-6-astra'});
    res.end(JSON.stringify({model: 'gpt-6-astra', status: 'completed', output: [{type: 'function_call', arguments: 'DO_NOT_RELEASE'}]}));
  }));
  const guard = createGuardService({...f, adapter: f.adapter, getUpstream: () => upstream,
    engineFactory: () => ({snapshot: () => ({providers: {'magpie:one': {enabled: true}}, records: []}),
      policy: id => ({enabled: id === 'magpie:one'}), ensure: async () => {}, assertAllowed() {}})});
  const origin = await listen(t, makeProxy({getUpstream: () => upstream, guard, requestScopedPolicy: true}));
  const denied = await send(origin, 'one/gpt-6-astra');
  assert.equal(denied.status, 409); assert.doesNotMatch(denied.body, /DO_NOT_RELEASE/);
  const allowed = await send(origin, 'two/gpt-6-astra');
  assert.equal(allowed.status, 200);
});

test('Magpie service lifecycle auto-detects, reuses matching options and stops without touching provider config', {timeout: 30000}, async t => {
  const f = fixture(t);
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const options = parseArgs(['start', '--port', String(port), '--runtime', f.runtime, '--config', f.configPath, '--magpie-dir', f.runtime]);
  const original = fs.readFileSync(path.join(f.runtime, 'providers.json'), 'utf8');
  try {
    const state = await start(options); assert.equal(state.backend, 'magpie'); assert.equal(state.state, 'magpie-plugin');
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), f.text);
    assert.equal(state.integration.modifiesCodexConfig, false);
    assert.equal((await start(options)).pid, state.pid);
    await assert.rejects(start({...options, backend: 'ccswitch'}), /different or unknown/);
  } finally { await stop(options); }
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), f.text);
  assert.equal(fs.readFileSync(path.join(f.runtime, 'providers.json'), 'utf8'), original);
});
