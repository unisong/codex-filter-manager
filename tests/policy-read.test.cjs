'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {DatabaseSync} = require('node:sqlite');
const {readFilterPolicy} = require('../src/config.cjs');
const {makeProxy, ADMIN} = require('../src/proxy.cjs');
const {readPolicyWithRetry, readErrorCode} = require('../src/policy-read.cjs');
const {createDiagnostics, buildReport} = require('../src/diagnostics.cjs');

async function setup(t, customRead, onLog = () => {}) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'filter-policy-test-'));
  const filename = path.join(directory, 'mock.db'), db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE proxy_config(app_type TEXT, auto_failover_enabled INTEGER); INSERT INTO proxy_config VALUES('codex',0); CREATE TABLE providers(id TEXT,app_type TEXT,is_current INTEGER,settings_config TEXT)");
  db.prepare('INSERT INTO providers VALUES(?,?,?,?)').run('demo', 'codex', 1,
    JSON.stringify({config: 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://demo.example/v1"'}));
  const overrides = {demo: {historyFilter: true, preserveEncryptedInclude: true, stripResponsesLiteHeader: false}};
  const received = [], diagnostics = createDiagnostics({runtime: directory});
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received.push(JSON.parse(raw)); res.end('{"ok":true}');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const read = () => readFilterPolicy(filename, overrides);
  const proxy = makeProxy({getUpstream: () => 'http://127.0.0.1:' + upstream.address().port,
    getFilterPolicy: () => customRead ? customRead({db, read, overrides}) : read(),
    log: (event, data) => { diagnostics.record(event, data); onLog(event, data); }});
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]);
    db.close(); assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const origin = 'http://127.0.0.1:' + proxy.address().port;
  const input = [{type: 'reasoning', encrypted_content: 'PRIVATE_CIPHER'}, {role: 'user', content: 'PRIVATE_PROMPT'}];
  return {db, read, overrides, received, diagnostics, origin, input,
    send: route => fetch(origin + (route || '/v1/responses'), {method: 'POST', body: JSON.stringify({input})}),
    health: () => fetch(origin + ADMIN + '/health').then(r => r.json())};
}

test('transient SQLite lock retries without blocking the event loop, then filters before sending', async t => {
  let release;
  const f = await setup(t, undefined, event => {
    if (event === 'policy-read-retry' && !release) release = setTimeout(() => f.db.exec('COMMIT'), 20);
  });
  f.db.exec('BEGIN EXCLUSIVE');
  assert.deepEqual(f.read().readError, {code: 'SQLITE_BUSY', retryable: true});
  t.after(() => clearTimeout(release));
  const result = await f.send(); assert.equal(result.status, 200);
  assert.deepEqual(f.received[0].input, [f.input[1]]);
  assert.equal((await f.health()).stats.policyReadRecoveries, 1);
  const report = await buildReport({service: {running: true, backend: 'ccswitch', state: 'filtering'}, recorder: f.diagnostics});
  assert.ok(report.checks.some(c => c.code === 'policy-read-errors-seen'));
  assert.match(JSON.stringify(report), /SQLITE_BUSY/);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|demo\.example|mock\.db/);
});

test('persistent lock returns retryable local 503 after three retries, never cached passthrough or upstream work', async t => {
  const f = await setup(t);
  assert.equal((await f.send()).status, 200);
  f.db.exec('BEGIN EXCLUSIVE');
  const response = await f.send(); const body = await response.json();
  assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(body.error.code, 'filter_policy_unavailable'); assert.equal(body.error.type, 'service_unavailable');
  assert.match(body.error.request_id, /^[a-f\d-]{36}$/); assert.equal(f.received.length, 1);
  const stats = (await f.health()).stats;
  assert.equal(stats.policyReadRetries, 3); assert.equal(stats.policyReadBlockedRequests, 1);
  const events = f.diagnostics.snapshot().events.filter(e => e.requestId === body.error.request_id);
  assert.equal(events.filter(e => e.event === 'policy-read-error').length, 4);
  assert.ok(!events.some(e => ['filtered', 'upstream-response'].includes(e.event)));
  f.db.exec('COMMIT'); assert.equal((await f.send()).status, 200); assert.equal(f.received.length, 2);
});

test('a read failure after upload is also retried and cannot bypass filtering', async t => {
  let reads = 0, release;
  const f = await setup(t, ({db, read}) => {
    if (++reads === 2) { db.exec('BEGIN EXCLUSIVE'); release = setTimeout(() => db.exec('COMMIT'), 60); }
    return read();
  });
  t.after(() => clearTimeout(release));
  assert.equal((await f.send()).status, 200);
  assert.ok(reads >= 3); assert.deepEqual(f.received[0].input, [f.input[1]]);
  assert.equal((await f.health()).stats.policyReadRecoveries, 1);
});

test('the fresh supplier after a retry uses its own saved rule, not the previous enabled rule', async t => {
  let release;
  const f = await setup(t, undefined, event => {
    if (event === 'policy-read-retry' && !release) release = setTimeout(() => f.db.exec('COMMIT'), 20);
  });
  assert.equal((await f.send()).status, 200);
  f.db.exec('BEGIN EXCLUSIVE');
  f.db.prepare('UPDATE providers SET id=?').run('other');
  t.after(() => clearTimeout(release));
  assert.equal((await f.send()).status, 200);
  assert.deepEqual(f.received[1].input, f.input, 'unconfigured supplier remains intentional passthrough');
  assert.equal((await f.health()).stats.policyReadRecoveries, 1);
});

test('malformed database configuration is blocked immediately without useless retries', async t => {
  const f = await setup(t); f.db.exec("UPDATE providers SET settings_config='not-json'");
  assert.equal((await f.send()).status, 503);
  assert.equal((await f.health()).stats.policyReadRetries, 0); assert.equal(f.received.length, 0);
});

test('compact endpoint cannot slip through an unreadable policy', async t => {
  const f = await setup(t, () => { throw Object.assign(Error('PRIVATE_PATH'), {code: 'EACCES'}); });
  const result = await f.send('/v1/responses/compact');
  assert.equal(result.status, 503); assert.equal(f.received.length, 0);
  assert.doesNotMatch(await result.text(), /PRIVATE_PATH/);
});

test('cancellation interrupts the policy backoff without another read', async () => {
  let reads = 0; const controller = new AbortController();
  const pending = readPolicyWithRetry(() => {
    reads++; throw Object.assign(Error('locked'), {code: 'ERR_SQLITE_ERROR', errcode: 5});
  }, {signal: controller.signal, onEvent: event => { if (event === 'policy-read-retry') controller.abort(); }});
  await assert.rejects(pending, {name: 'AbortError'}); assert.equal(reads, 1);
  assert.equal(readErrorCode({code: 'ERR_SQLITE_ERROR', errcode: 261}), 'SQLITE_BUSY');
  assert.equal(readErrorCode({code: 'ERR_SQLITE_ERROR', errcode: 26}), 'SQLITE_NOTADB');
});
