'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {randomUUID} = require('node:crypto');
const {createDiagnostics, buildReport} = require('../src/diagnostics.cjs');
const {makeProxy, ADMIN} = require('../src/proxy.cjs');
const {diagnose, parseArgs} = require('../src/filter.cjs');
function fixture(t) {
  const root = fs.realpathSync(process.env.PI_SCRATCH_DIR), runtime = fs.mkdtempSync(path.join(root, 'diagnostics-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(runtime)), root); fs.rmSync(runtime, {recursive: true, force: true}); });
  return runtime;
}
test('diagnostics allow-list, provider anonymization, disk rotation and age pruning', t => {
  const runtime = fixture(t); let now = Date.now();
  const d = createDiagnostics({runtime, maxBytes: 1024, files: 3, now: () => now});
  for (let i = 0; i < 50; i++) d.record('filtered', {requestId: randomUUID(), removed: i, provider: 'PRIVATE_PROVIDER', message: 'SECRET_BODY', token: 'SECRET_KEY', status: 200});
  const files = fs.readdirSync(runtime); assert.ok(files.length <= 3);
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(runtime, file), 'utf8');
    assert.ok(Buffer.byteLength(bytes) <= 1024); assert.doesNotMatch(bytes, /SECRET|PRIVATE_PROVIDER/);
    for (const line of bytes.trim().split('\n')) assert.match(JSON.parse(line).providerToken, /^p-[a-f0-9]{12}$/);
  }
  now += 8 * 86400000; d.record('listening');
  assert.deepEqual(fs.readdirSync(runtime), ['diagnostics.jsonl']);
  assert.equal(d.snapshot().events.length, 1);
});
test('diagnostic write failures do not throw and are reported', t => {
  const runtime = fixture(t), obstruction = path.join(runtime, 'file'); fs.writeFileSync(obstruction, 'x');
  const d = createDiagnostics({runtime: obstruction});
  assert.doesNotThrow(() => d.record('request-received')); assert.equal(d.snapshot().writeFailures, 1);
});
test('reports distinguish no requests, passthrough, clean input and native unobserved state', async t => {
  const runtime = fixture(t), d = createDiagnostics({runtime});
  const management = {state: () => ({providers: [{rule: {historyFilter: true}}]})};
  const options = {service: {running: true, backend: 'ccswitch', state: 'filtering'}, management, recorder: d};
  assert.ok((await buildReport(options)).checks.some(c => c.code === 'no-requests'));
  const requestId = randomUUID(); d.record('request-received', {requestId}); d.record('request-policy', {requestId, filter: false, reason: 'not-configured'});
  assert.ok((await buildReport(options)).checks.some(c => c.code === 'passthrough'));
  d.record('filtered', {requestId, removed: 0});
  assert.ok((await buildReport(options)).checks.some(c => c.code === 'clean-history'));
  const native = await buildReport({...options, service: {running: true, backend: 'magpie', state: 'magpie-plugin'}});
  assert.ok(native.checks.some(c => c.code === 'native-runtime-unobserved')); assert.ok(!native.checks.some(c => c.code === 'no-requests'));
  const unknown = await buildReport({...options, requestObservationAvailable: false});
  assert.ok(unknown.checks.some(c => c.code === 'live-diagnostics-unavailable'));
  assert.ok(!unknown.checks.some(c => ['no-requests', 'clean-history'].includes(c.code)));
});
test('concurrent older requests and management errors cannot overwrite newest request decision', t => {
  const d = createDiagnostics({runtime: fixture(t)}), older = randomUUID(), newer = randomUUID();
  d.record('request-received', {requestId: older}); d.record('request-received', {requestId: newer});
  d.record('request-policy', {requestId: newer, filter: false}); d.record('filtered', {requestId: older}); d.record('blocked', {requestId: randomUUID()});
  assert.equal(d.snapshot().lastDecision.requestId, newer);
});
test('proxy correlates passthrough, filtering and upstream failures; report stays private and authenticated', async t => {
  const runtime = fixture(t), d = createDiagnostics({runtime}); let enabled = false;
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(503); res.end('SECRET_UPSTREAM_BODY'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const management = {state: () => ({providers: [{name: 'PRIVATE_NAME', endpoint: 'https://private.example', rule: {historyFilter: enabled}}]}), handle: () => ({})};
  const proxy = makeProxy({getUpstream: () => 'http://127.0.0.1:' + upstream.address().port, token: 'PRIVATE_CONTROL_TOKEN', dashboard: management,
    getState: () => ({running: true, state: 'filtering', backend: 'ccswitch'}), log: d.record,
    getDiagnostics: () => buildReport({service: {running: true, state: 'filtering', backend: 'ccswitch'}, management, recorder: d}),
    getFilterPolicy: () => ({filter: enabled, reason: 'user-override', provider: 'PRIVATE_NAME'})});
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]); });
  const origin = 'http://127.0.0.1:' + proxy.address().port;
  const send = () => fetch(origin + '/v1/responses', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer SECRET_KEY'}, body: JSON.stringify({input: [{type: 'reasoning', encrypted_content: 'SECRET_CIPHER'}, {role: 'user', content: 'SECRET_PROMPT'}]})}).then(r => r.text());
  await send(); enabled = true; await send();
  assert.equal((await fetch(origin + ADMIN + '/api/diagnostics')).status, 403);
  const result = await (await fetch(origin + ADMIN + '/api/diagnostics', {headers: {'x-filter-token': 'PRIVATE_CONTROL_TOKEN'}})).json();
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|PRIVATE_|private\.example/);
  const events = result.diagnostics.diagnostics.events, filtered = events.find(e => e.event === 'filtered');
  assert.equal(filtered.removed, 1);
  assert.ok(events.some(e => e.requestId === filtered.requestId && e.event === 'upstream-http-error' && e.status === 503));
  assert.equal(events.filter(e => e.event === 'request-received').length, 2);
  assert.ok(events.some(e => e.event === 'request-policy' && e.filter === false));
});
test('offline diagnose works without service and does not create or change configuration', async t => {
  const runtime = fixture(t), options = parseArgs(['diagnose', '--runtime', runtime, '--config', path.join(runtime, 'absent.toml'), '--cc-db', path.join(runtime, 'absent.db')]);
  const before = fs.readdirSync(runtime);
  const report = await diagnose(options);
  assert.equal(report.service.running, false); assert.ok(report.checks.some(c => c.code === 'service-unavailable'));
  assert.deepEqual(fs.readdirSync(runtime), before); assert.doesNotMatch(JSON.stringify(report), new RegExp(runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
test('aborted upstream is distinguished from intentional client cancellation', async t => {
  const runtime = fixture(t), d = createDiagnostics({runtime}); let upstreamResponse;
  const upstream = http.createServer((req, res) => { req.resume(); upstreamResponse = res; res.writeHead(200, {'content-type': 'text/event-stream'}); res.write(': ready\n\n'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = makeProxy({getUpstream: () => 'http://127.0.0.1:' + upstream.address().port, log: d.record});
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]); });
  const origin = 'http://127.0.0.1:' + proxy.address().port;
  const first = await fetch(origin + '/v1/responses', {method: 'POST', body: '{}'});
  const failed = first.text(); upstreamResponse.destroy();
  await assert.rejects(failed);
  assert.equal(d.snapshot().counters['upstream-stream-error'], 1);
  const controller = new AbortController();
  const second = await fetch(origin + '/v1/responses', {method: 'POST', body: '{}', signal: controller.signal});
  const cancelled = second.text(); controller.abort(); await assert.rejects(cancelled);
  for (let i = 0; i < 20 && d.snapshot().counters['request-disconnected'] < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(d.snapshot().counters['upstream-stream-error'], 1);
  assert.equal(d.snapshot().counters['request-disconnected'], 2);
});
