'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), {once} = require('node:events');
const {probeWithRetry} = require('./guard-retry.cjs');
const {guardFailure, probe} = require('./guard-transport.cjs');
const transient = (retryAfterMs = 0) => Object.assign(guardFailure('synthetic transient'), {retryable: true, retryAfterMs});
test('three extra attempts are shared across samples, using the same prompt and context', async () => {
  const budget = {used: 0}, waits = [], progress = [], context = {model: 'gpt-6-astra'};
  const invoke = (prompt, failures) => {
    let attempts = 0;
    return probeWithRetry({context, prompt, budget, wait: async ms => waits.push(ms), onProgress: value => progress.push(value),
      probe: async options => {assert.equal(options.context, context);assert.equal(options.prompt, prompt);if (attempts++ < failures) throw transient();return prompt;}});
  };
  assert.equal(await invoke('first same challenge', 1), 'first same challenge');
  assert.equal(await invoke('second same challenge', 2), 'second same challenge');
  await assert.rejects(invoke('confirmation challenge', 1), /3 次额外重试额度已用完/);
  assert.equal(budget.used, 3);assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(progress.filter(value => value.waiting).length, 3);
});
test('Retry-After is respected and waits over 60 seconds stop without another attempt', async () => {
  let attempts = 0;const waits = [], budget = {used: 0};
  await probeWithRetry({budget, wait: async ms => waits.push(ms), probe: async () => {if (!attempts++) throw transient(12000);return 'ok';}});
  assert.deepEqual(waits, [12000]);assert.equal(attempts, 2);
  await assert.rejects(probeWithRetry({budget, probe: async () => {throw transient(61000);}}), /超过 60 秒/);
  assert.equal(budget.used, 1);
});
test('non-transient failures, completed invalid samples and model mismatch never retry', async () => {
  for (const error of [guardFailure('quota'), guardFailure('invalid sample'), guardFailure('model mismatch', 'guard_blocked')]) {
    let calls = 0;
    await assert.rejects(probeWithRetry({budget: {used: 0}, probe: async () => {calls++;throw error;}}), value => value === error);
    assert.equal(calls, 1);
  }
});
test('cancellation during retry backoff prevents further paid attempts', async () => {
  let calls = 0;const controller = new AbortController();
  await assert.rejects(probeWithRetry({signal: controller.signal, budget: {used: 0},
    probe: async () => {calls++;throw transient();}, wait: async () => {controller.abort();throw new Error('cancel');}}), /取消/);
  assert.equal(calls, 1);
});
test('HTTP errors classify transient retries without retrying auth, quota or unsupported models', async t => {
  let status = 429, body = {}, retryAfter = '3';
  const server = http.createServer((_request, response) => {response.writeHead(status, {'content-type': 'application/json', 'retry-after': retryAfter});response.end(JSON.stringify(body));});
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const context = {model: 'gpt-6-astra', effort: 'high', transport: {upstream: 'http://127.0.0.1:' + server.address().port, path: '/v1/responses', headers: {}}};
  for (const [code, payload, retryable] of [
    [429, {}, true], [503, {}, true], [403, {}, false], [401, {}, false],
    [429, {error: {code: 'insufficient_quota'}}, false], [503, {error: {code: 'model_not_found'}}, false]
  ]) {
    status = code;body = payload;
    await assert.rejects(probe({context, prompt: 'Offline fixture'}), error => {
      assert.equal(error.retryable, retryable);assert.equal(error.retryAfterMs, 3000);return error.code === 'guard_unverified';
    });
  }
});
test('invalidating a route while the guard is backing off cancels further attempts', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const {createGuard} = require('./guard.cjs');
  const parent = fs.realpathSync(process.env.PI_SCRATCH_DIR || os.tmpdir());
  const runtime = fs.mkdtempSync(path.join(parent, 'guard-retry-route-'));
  t.after(() => {assert.equal(path.dirname(fs.realpathSync(runtime)), parent);fs.rmSync(runtime, {recursive: true, force: true});});
  let attempts = 0;
  const guard = createGuard({runtime, probe: async () => {attempts++;throw transient();}});
  guard.configure('provider', {enabled: true, ttlSeconds: 600});
  const result = guard.ensure({key: 'route', providerId: 'provider', model: 'gpt-6-astra', effort: 'high'})
    .then(() => null, error => error);
  const deadline = Date.now() + 2000;
  while (!guard.snapshot().checking[0]?.progress?.waiting && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(guard.snapshot().checking[0].progress.waiting, true);
  guard.invalidate('provider');
  assert.equal((await result).code, 'guard_unverified');
  assert.equal(attempts, 1);assert.equal(guard.snapshot().history.length, 1);
});
