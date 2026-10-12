'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {createGuard, classify} = require('./guard.cjs');

const sample = Array.from({length: 300}, (_, index) => 1 + index).join(',');
const requested = 'gpt-6-astra', different = 'gpt-6-luna';
const ctx = extra => ({key: 'opaque-route-key', providerId: 'p1', providerName: 'Test Supplier',
  model: requested, effort: 'high', transport: {headers: {authorization: 'SECRET_DO_NOT_SAVE'},
    upstream: 'http://127.0.0.1:1', path: '/v1/responses'}, ...extra});
const scoring = (winner = requested, probability = 0.94, expectedProbability = 0.03) => ({
  prediction: winner, used_outputs: 3, diagnostics: Array.from({length: 3}, () => ({accepted: true})),
  results: [{model: winner, probability}, {model: winner === requested ? different : requested, probability: expectedProbability}]
});
function historicalRecord(record) {
  const {cacheValid, cacheReason, outcome, ...verdict} = record;
  return verdict;
}
function setup(t, extras = {}) {
  const parent = fs.realpathSync(process.env.PI_SCRATCH_DIR || os.tmpdir());
  const runtime = fs.mkdtempSync(path.join(parent, 'filter-guard-test-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(runtime)), parent);
    fs.rmSync(runtime, {recursive: true, force: true});
  });
  let probes = 0, clock = Date.parse('2026-10-11T00:00:00Z');
  const options = {runtime, probe: async () => { probes++; return {text: sample, model: requested}; },
    analyze: () => scoring(), now: () => clock, ...extras};
  return {runtime, options, guard: createGuard(options), count: () => probes,
    advance: ms => { clock += ms; }};
}

test('disabled providers send no automatic probes, while explicit manual checks can test before enabling', async t => {
  const f = setup(t);
  assert.deepEqual(f.guard.policy('new'), {enabled: false, ttlSeconds: 600});
  assert.deepEqual(await f.guard.ensure(ctx()), {enabled: false});
  assert.equal(f.count(), 0);
  assert.equal(fs.existsSync(path.join(f.runtime, 'model-guard.json')), false);
  assert.deepEqual(await f.guard.ensure(ctx(), {force: true}), {enabled: false, status: 'passed'});
  assert.equal(f.count(), 3);
  assert.equal(f.guard.snapshot().records[0].status, 'passed');
  assert.equal(f.guard.snapshot().records[0].cacheValid, false);
  assert.match(f.guard.snapshot().records[0].cacheReason, /关闭/);
  assert.deepEqual(await f.guard.ensure(ctx()), {enabled: false}); assert.equal(f.count(), 3);
});

test('passing checks deduplicate callers, cache by route/model/effort key, expire and omit secrets', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 60});
  await Promise.all([f.guard.ensure(ctx()), f.guard.ensure(ctx()), f.guard.ensure(ctx())]);
  assert.equal(f.count(), 3);
  assert.equal((await f.guard.ensure(ctx())).status, 'passed'); assert.equal(f.count(), 3);
  const lastVerdict = historicalRecord(f.guard.snapshot().records[0]);
  assert.equal(f.guard.snapshot().records[0].cacheValid, true);
  f.advance(60001);
  const expired = f.guard.snapshot().records[0];
  assert.equal(expired.status, 'passed'); assert.equal(expired.cacheValid, false);
  assert.match(expired.cacheReason, /过期/);
  assert.deepEqual(historicalRecord(expired), lastVerdict);
  await f.guard.ensure(ctx()); assert.equal(f.count(), 6);
  await f.guard.ensure(ctx({key: 'other-model-effort-route'})); assert.equal(f.count(), 9);
  const persisted = fs.readFileSync(path.join(f.runtime, 'model-guard.json'), 'utf8');
  assert.equal(persisted.includes('SECRET_DO_NOT_SAVE'), false);
  assert.equal(persisted.includes('transport'), false); assert.equal(persisted.includes(sample), false);
  assert.equal(persisted.includes('cacheValid'), false); assert.equal(persisted.includes('cacheReason'), false);
});

test('zero TTL verifies each new request while concurrent same-key callers still share a batch', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 0});
  await Promise.all([f.guard.ensure(ctx()), f.guard.ensure(ctx())]); assert.equal(f.count(), 3);
  const passed = f.guard.snapshot().records[0];
  assert.equal(passed.status, 'passed'); assert.equal(passed.cacheValid, false);
  assert.equal(passed.prediction, requested); assert.equal(passed.rounds, 1);
  assert.match(passed.cacheReason, /每次请求/);
  await f.guard.ensure(ctx()); assert.equal(f.count(), 6);
  assert.equal(f.guard.snapshot().records[0].status, 'passed');
  assert.equal(f.guard.snapshot().records[0].cacheValid, false);
});

test('unsupported expected models fail closed without spending probe tokens', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await assert.rejects(f.guard.ensure(ctx({model: 'gpt-6.1-sol'})), {code: 'guard_unsupported', status: 409});
  assert.equal(f.count(), 0); assert.equal(f.guard.snapshot().records[0].status, 'unsupported');
});

test('two strong batches with the same different candidate latch and stay locked across restart', async t => {
  let blocked = 0;
  const f = setup(t, {analyze: () => scoring(different), onBlock: () => { blocked++; }});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
  assert.equal(f.count(), 6); assert.equal(blocked, 1);
  const record = f.guard.snapshot().records[0];
  assert.equal(record.status, 'blocked'); assert.equal(record.prediction, different); assert.equal(record.rounds, 2);
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'}); assert.equal(f.count(), 6);
  const restarted = createGuard(f.options);
  await assert.rejects(restarted.ensure(ctx()), {code: 'guard_blocked'}); assert.equal(f.count(), 6);
  assert.throws(() => restarted.assertAllowed(ctx()), {code: 'guard_blocked'});
});

test('inconclusive, contradictory confirmations, network errors and short samples stay unverified', async t => {
  for (const kind of ['weak', 'contradictory', 'network', 'short']) {
    let rounds = 0;
    const f = setup(t, {analyze: () => {
      rounds++;
      return kind === 'weak' ? scoring(different, 0.6, 0.3) : rounds === 1 ? scoring(different) : scoring();
    }});
    if (kind === 'network' || kind === 'short') {
      f.guard = createGuard({...f.options, probe: async () => {
        if (kind === 'network') throw new Error('network failure with secret');
        return {text: '1,2,3', model: requested};
      }});
    }
    f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
    await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_unverified'});
    assert.equal(f.guard.snapshot().records[0].status, 'unverified', kind);
    assert.doesNotThrow(() => f.guard.assertAllowed(ctx()), kind);
    assert.equal(JSON.stringify(f.guard.snapshot()).includes('secret'), false);
  }
});

test('failed manual recheck preserves durable lock; successful manual recheck unlocks', async t => {
  let current = 'mismatch';
  const f = setup(t, {analyze: () => current === 'mismatch' ? scoring(different)
    : current === 'weak' ? scoring(different, 0.6, 0.3) : scoring()});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
  current = 'weak';
  await assert.rejects(f.guard.ensure(ctx(), {force: true}), {code: 'guard_unverified'});
  assert.equal(f.guard.snapshot().records[0].status, 'blocked');
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
  current = 'pass';
  assert.equal((await f.guard.ensure(ctx(), {force: true})).status, 'passed');
  assert.doesNotThrow(() => f.guard.assertAllowed(ctx()));
});

test('clear removes a lock and cached trust, requiring a fresh check', async t => {
  let outcome = scoring(different);
  const f = setup(t, {analyze: () => outcome});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
  f.guard.clear(ctx().key);
  assert.equal(f.guard.snapshot().records[0].status, 'unchecked');
  outcome = scoring(); await f.guard.ensure(ctx()); assert.equal(f.count(), 9);
  f.guard.clear(ctx().key); await f.guard.ensure(ctx()); assert.equal(f.count(), 12);
});

test('restart never trusts a persisted pass', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await f.guard.ensure(ctx()); assert.equal(f.count(), 3);
  const lastVerdict = historicalRecord(f.guard.snapshot().records[0]);
  const restarted = createGuard(f.options);
  const previous = restarted.snapshot().records[0];
  assert.equal(previous.status, 'passed'); assert.equal(previous.cacheValid, false);
  assert.match(previous.cacheReason, /重启/);
  assert.deepEqual(historicalRecord(previous), lastVerdict);
  await restarted.ensure(ctx()); assert.equal(f.count(), 6);
  assert.equal(restarted.snapshot().records[0].cacheValid, true);
});

test('restart discards interrupted checking and suspicion without claiming a completed verdict', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await f.guard.ensure(ctx());
  const filename = path.join(f.runtime, 'model-guard.json');
  const persisted = JSON.parse(fs.readFileSync(filename, 'utf8'));
  for (const status of ['checking', 'suspect']) {
    persisted.records[0].status = status;
    fs.writeFileSync(filename, JSON.stringify(persisted));
    const previous = createGuard(f.options).snapshot().records[0];
    assert.equal(previous.status, 'unchecked'); assert.equal(previous.cacheValid, false);
    assert.match(previous.reason, /重启/);
  }
});

test('settings updates retain historical pass evidence while requiring a fresh admission', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  const admitted = ctx(); await f.guard.ensure(admitted);
  const lastVerdict = historicalRecord(f.guard.snapshot().records[0]);
  f.guard.configure('p1', {enabled: true, ttlSeconds: 60});
  const stale = f.guard.snapshot().records[0];
  assert.equal(stale.status, 'passed'); assert.equal(stale.cacheValid, false);
  assert.match(stale.cacheReason, /设置已更新/);
  assert.deepEqual(historicalRecord(stale), lastVerdict);
  assert.throws(() => f.guard.assertAllowed(admitted), {code: 'guard_unverified'});
  await f.guard.ensure(ctx()); assert.equal(f.count(), 6);
  assert.equal(f.guard.snapshot().records[0].cacheValid, true);
});

test('settings validate intervals, preserve prototype-like IDs safely and invalidate admitted output', async t => {
  const f = setup(t);
  for (const ttlSeconds of [-1, 1, 59, 3601, '600']) {
    assert.throws(() => f.guard.configure('p1', {enabled: true, ttlSeconds}), {code: 'guard_invalid_setting'});
  }
  f.guard.configure('__proto__', {enabled: true, ttlSeconds: 60});
  assert.deepEqual(f.guard.snapshot().providers.__proto__, {enabled: true, ttlSeconds: 60});
  assert.equal({}.enabled, undefined);
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  const context = ctx(); await f.guard.ensure(context);
  const lastVerdict = historicalRecord(f.guard.snapshot().records[0]);
  f.guard.configure('p1', {enabled: false, ttlSeconds: 600});
  const disabled = f.guard.snapshot().records[0];
  assert.equal(disabled.status, 'passed'); assert.equal(disabled.cacheValid, false);
  assert.match(disabled.cacheReason, /关闭/);
  assert.deepEqual(historicalRecord(disabled), lastVerdict);
  assert.throws(() => f.guard.assertAllowed(context), {code: 'guard_unverified'});
  assert.deepEqual(await f.guard.ensure(ctx()), {enabled: false});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await f.guard.ensure(ctx()); assert.equal(f.count(), 6);
});

test('one disconnected waiter does not cancel a shared batch for another requester', async t => {
  let release, calls = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = setup(t, {probe: async ({signal}) => {
    calls++; await barrier; assert.equal(signal.aborted, false); return {text: sample, model: requested};
  }});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  const aborted = new AbortController();
  const first = f.guard.ensure(ctx(), {signal: aborted.signal});
  const second = f.guard.ensure(ctx());
  aborted.abort(); await assert.rejects(first, {code: 'guard_unverified'});
  release(); assert.equal((await second).status, 'passed'); assert.equal(calls, 3);
});

test('settings changed during a batch cannot establish a pass', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = setup(t, {probe: async () => { await barrier; return {text: sample, model: requested}; }});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  const pending = f.guard.ensure(ctx());
  f.guard.configure('p1', {enabled: false, ttlSeconds: 600}); release();
  await assert.rejects(pending, {code: 'guard_unverified'});
  assert.equal(f.guard.snapshot().records.some(record => record.status === 'passed'), false);
});

test('overall detection timeout fails closed and aborts probe work within 150 seconds', async t => {
  let probeSignal;
  const f = setup(t, {probe: async ({signal}) => { probeSignal = signal; return new Promise(() => {}); }});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = f.guard.ensure(ctx());
  const rejected = assert.rejects(pending, {code: 'guard_unverified'});
  t.mock.timers.tick(145000); await rejected;
  assert.equal(probeSignal.aborted, true);
  assert.equal(f.guard.snapshot().records[0].status, 'unverified');
  assert.equal(f.guard.snapshot().checking.length, 0);
});

test('response metadata mismatch directly blocks and invokes cancellation', async t => {
  let blocked = 0;
  const f = setup(t, {probe: async () => ({text: sample, model: different}), onBlock: () => { blocked++; }});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
  assert.equal(f.guard.snapshot().records[0].status, 'blocked'); assert.ok(blocked >= 1);
});

test('metadata mismatch from transport latches, and a failed manual recheck preserves the latch', async t => {
  let mismatch = true;
  const f = setup(t, {probe: async () => {
    if (mismatch) { const error = new Error('transport metadata mismatch'); error.code = 'guard_blocked'; throw error; }
    throw new Error('network failure');
  }});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
  assert.equal(f.guard.snapshot().records[0].status, 'blocked'); mismatch = false;
  await assert.rejects(f.guard.ensure(ctx(), {force: true}), {code: 'guard_unverified'});
  assert.equal(f.guard.snapshot().records[0].status, 'blocked');
});

test('upstream ModelTrace minimum accepts imperfect count without accepting too-short samples', async t => {
  const f = setup(t, {probe: async () => ({text: sample.split(',').slice(0, 165).join(','), model: requested})});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  assert.equal((await f.guard.ensure(ctx())).status, 'passed');
});

test('route invalidation removes passes and admitted trust while retaining durable locks', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  const admitted = ctx(); await f.guard.ensure(admitted); assert.equal(f.count(), 3);
  const lastVerdict = historicalRecord(f.guard.snapshot().records[0]);
  f.guard.invalidate('p1');
  const invalidated = f.guard.snapshot().records[0];
  assert.equal(invalidated.status, 'passed'); assert.equal(invalidated.cacheValid, false);
  assert.match(invalidated.cacheReason, /路由已切换/);
  assert.deepEqual(historicalRecord(invalidated), lastVerdict);
  assert.throws(() => f.guard.assertAllowed(admitted), {code: 'guard_unverified'});
  await f.guard.ensure(ctx()); assert.equal(f.count(), 6);
  f.guard.block(ctx(), 'blocked'); f.guard.invalidate('p1');
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
});

test('normal requests wait for manual recheck instead of bypassing it through a cached pass', async t => {
  let release, calls = 0, recheck = false;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = setup(t, {probe: async () => {
    calls++; if (recheck) await barrier; return {text: sample, model: requested};
  }});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600}); await f.guard.ensure(ctx());
  recheck = true;
  const manual = f.guard.ensure(ctx(), {force: true});
  let settled = false;
  const ordinary = f.guard.ensure(ctx()).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release(); await Promise.all([manual, ordinary]); assert.equal(calls, 6);
});

test('failed manual recheck cannot revive an older cached pass', async t => {
  let mode = 'pass';
  const f = setup(t, {analyze: () => mode === 'pass' ? scoring() : scoring(different, 0.6, 0.3)});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600}); await f.guard.ensure(ctx());
  mode = 'weak'; await assert.rejects(f.guard.ensure(ctx(), {force: true}), {code: 'guard_unverified'});
  assert.equal(f.count(), 6);
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_unverified'}); assert.equal(f.count(), 9);
});

test('a quick contradictory confirmation cannot restore output admitted before suspicion', async t => {
  let rounds = 0;
  const f = setup(t, {analyze: () => { rounds++; return rounds === 2 ? scoring(different) : scoring(); }});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  const admitted = ctx(); await f.guard.ensure(admitted);
  await assert.rejects(f.guard.ensure(ctx(), {force: true}), {code: 'guard_unverified'});
  assert.equal(f.guard.snapshot().records[0].status, 'unverified');
  assert.throws(() => f.guard.assertAllowed(admitted), {code: 'guard_unverified'});
  const fresh = ctx(); await f.guard.ensure(fresh); assert.doesNotThrow(() => f.guard.assertAllowed(fresh));
  assert.throws(() => f.guard.assertAllowed(admitted), {code: 'guard_unverified'});
});

test('first strong mismatch during manual recheck blocks admitted output before confirmation finishes', async t => {
  let rounds = 0, calls = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = setup(t, {probe: async () => {
    calls++; if (calls > 6) await barrier; return {text: sample, model: requested};
  }, analyze: () => { rounds++; return rounds === 1 ? scoring() : scoring(different); }});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  const admitted = ctx(); await f.guard.ensure(admitted);
  const manual = f.guard.ensure(ctx(), {force: true});
  while (calls < 9) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.guard.snapshot().records[0].status, 'suspect');
  assert.throws(() => f.guard.assertAllowed(admitted), {code: 'guard_unverified'});
  release(); await assert.rejects(manual, {code: 'guard_blocked'});
});

test('corrupt configuration fails closed without silently losing enabled policy', async t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.runtime, 'model-guard.json'), '{broken');
  const broken = createGuard(f.options);
  assert.throws(() => broken.policy('p1'), {code: 'guard_unverified'});
  await assert.rejects(broken.ensure(ctx()), {code: 'guard_unverified'});
  assert.throws(() => broken.configure('p1', {enabled: false, ttlSeconds: 600}), {code: 'guard_unverified'});
  assert.equal(f.count(), 0); assert.ok(broken.snapshot().error);
});

test('reference bank, pinned scorer and classification are executable with no external package', async () => {
  const vendor = path.join(__dirname, 'vendor', 'modeltrace');
  const provenance = JSON.parse(fs.readFileSync(path.join(vendor, 'provenance.json'), 'utf8'));
  for (const [filename, value] of Object.entries(provenance.files)) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(vendor, filename))).digest('hex'), value.sha256);
  }
  const {analyzeGlobalOutputs} = await import(pathToFileURL(path.join(vendor, 'fingerprint-core.mjs')).href);
  const bank = JSON.parse(fs.readFileSync(path.join(vendor, 'unified_bank.json'), 'utf8'));
  const result = analyzeGlobalOutputs(Array.from({length: 3}, () => ({text: sample, expected_count: 300})), bank);
  assert.equal(result.used_outputs, 3); assert.equal(result.results.length, bank.models.length);
  assert.ok(bank.models.some(model => model.id === requested));
  assert.equal(bank.models.some(model => model.id === 'gpt-6.1-sol'), false);
  assert.equal(classify(scoring(), requested).outcome, 'passed');
  assert.equal(classify(scoring(different), requested).outcome, 'difference');
});

test('each real same-key check has distinct immutable history even at one timestamp, while cached requests add none', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 1800});
  await Promise.all([f.guard.ensure(ctx()), f.guard.ensure(ctx())]);
  const automatic = f.guard.snapshot().history[0];
  await f.guard.ensure(ctx()); assert.equal(f.count(), 3);
  assert.equal(f.guard.snapshot().history.length, 1);
  await f.guard.ensure(ctx(), {force: true});
  await f.guard.ensure(ctx(), {force: true});
  const state = f.guard.snapshot();
  assert.equal(f.count(), 9); assert.equal(state.records.length, 1);
  assert.equal(state.history.length, 3); assert.equal(state.historyLimit, 100);
  assert.equal(new Set(state.history.map(record => record.id)).size, 3);
  assert.equal(new Set(state.history.map(record => record.checkedAt)).size, 1);
  assert.deepEqual(state.history.map(record => record.source), ['manual', 'manual', 'automatic']);
  assert.deepEqual(state.history[2], automatic);
  state.history[0].reason = 'MUTATED'; state.history[0].status = 'blocked'; state.history.pop();
  assert.equal(f.guard.snapshot().history.length, 3);
  assert.equal(f.guard.snapshot().history[0].status, 'passed');
  assert.doesNotMatch(f.guard.snapshot().history[0].reason, /MUTATED/);
  const saved = JSON.parse(fs.readFileSync(path.join(f.runtime, 'model-guard.json'), 'utf8'));
  assert.deepEqual(saved.history, f.guard.snapshot().history);
  assert.doesNotMatch(JSON.stringify(saved.history), /SECRET_DO_NOT_SAVE|transport|cacheValid|cacheReason|output|prompt/);
  assert.equal(saved.history.some(record => Object.hasOwn(record, 'outcome')), false);
});

test('history keeps only the newest 100 attempts and survives restart without restoring trusted passes', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 1800});
  const ids = [];
  for (let attempt = 0; attempt < 103; attempt++) {
    await f.guard.ensure(ctx(), {force: true});
    ids.push(f.guard.snapshot().history[0].id);
  }
  const before = f.guard.snapshot();
  assert.equal(before.history.length, 100);
  assert.deepEqual(before.history.map(record => record.id), ids.slice(-100).reverse());
  const restarted = createGuard(f.options);
  assert.deepEqual(restarted.snapshot().history, before.history);
  assert.deepEqual(restarted.policy('p1'), {enabled: true, ttlSeconds: 1800});
  assert.equal(restarted.snapshot().records[0].cacheValid, false);
  await restarted.ensure(ctx()); assert.equal(f.count(), 104 * 3);
  assert.equal(restarted.snapshot().history.length, 100);
  assert.equal(restarted.snapshot().history[0].source, 'automatic');
});

test('legacy storage seeds terminal results once, skips interrupted work and retains locks independently', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 1800});
  await f.guard.ensure(ctx());
  const filename = path.join(f.runtime, 'model-guard.json');
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
  delete saved.history;
  const base = saved.records[0];
  saved.records.push({...base, key: 'old-unverified', status: 'unverified', reason: 'Network unavailable'},
    {...base, key: 'interrupted', status: 'checking'}, {...base, key: 'pending-confirmation', status: 'suspect'},
    {...base, key: 'cleared', status: 'unchecked'});
  saved.blocks['old-lock'] = {...base, key: 'old-lock', status: 'blocked', reason: 'Historical mismatch'};
  fs.writeFileSync(filename, JSON.stringify(saved));
  const migrated = createGuard(f.options);
  const first = migrated.snapshot().history;
  assert.equal(first.length, 3);
  assert.ok(first.every(record => record.source === 'legacy'));
  assert.deepEqual(new Set(first.map(record => record.status)), new Set(['passed', 'unverified', 'blocked']));
  assert.equal(migrated.snapshot().records.find(record => record.key === 'interrupted').status, 'unchecked');
  assert.equal(migrated.snapshot().records.find(record => record.key === 'opaque-route-key').cacheValid, false);
  // An ordinary persistence operation stores the seeded IDs once, including
  // when the seed is empty. Later restarts never regenerate or duplicate them.
  migrated.configure('p1', {enabled: true, ttlSeconds: 1800});
  const restarted = createGuard(f.options);
  assert.deepEqual(restarted.snapshot().history, first);
  assert.throws(() => restarted.assertAllowed(ctx({key: 'old-lock'})), {code: 'guard_blocked'});
});

test('clear and configuration changes keep historical evidence without adding fake check events', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 1800});
  await f.guard.ensure(ctx());
  const before = f.guard.snapshot().history;
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  f.guard.invalidate('p1'); f.guard.clear(ctx().key);
  assert.deepEqual(f.guard.snapshot().history, before);
  assert.equal(f.guard.snapshot().records[0].status, 'unchecked');
  await f.guard.ensure(ctx()); assert.equal(f.count(), 6);
  assert.equal(f.guard.snapshot().history.length, 2);
});

test('failed manual recheck records its actual failure while preserving the current durable lock', async t => {
  let mode = 'mismatch';
  const f = setup(t, {analyze: () => mode === 'mismatch' ? scoring(different)
    : mode === 'weak' ? scoring(different, 0.6, 0.3) : scoring()});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 1800});
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
  assert.equal(f.guard.snapshot().history.length, 1);
  assert.equal(f.guard.snapshot().history[0].status, 'blocked');
  assert.equal(f.guard.snapshot().history[0].rounds, 2);
  mode = 'weak'; await assert.rejects(f.guard.ensure(ctx(), {force: true}), {code: 'guard_unverified'});
  let state = f.guard.snapshot();
  assert.equal(state.records[0].status, 'blocked');
  assert.deepEqual(state.history.map(record => [record.status, record.source]), [['unverified', 'manual'], ['blocked', 'automatic']]);
  assert.equal(state.history[0].rounds, 1); assert.equal(state.history[0].score, 0.6);
  const count = f.count();
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
  assert.equal(f.count(), count); assert.equal(f.guard.snapshot().history.length, 2);
  mode = 'pass'; await f.guard.ensure(ctx(), {force: true});
  state = f.guard.snapshot();
  assert.equal(state.records[0].status, 'passed'); assert.equal(state.history[0].status, 'passed');
  assert.equal(state.history.length, 3); assert.equal(state.history[2].status, 'blocked');
});

test('parallel probe metadata mismatches yield one result and business-response locks append once per new lock', async t => {
  const f = setup(t, {probe: async () => ({text: sample, model: different})});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
  assert.equal(f.guard.snapshot().history.length, 1);
  assert.equal(f.guard.snapshot().history[0].source, 'automatic');
  f.guard.block(ctx(), 'another mismatch', different);
  assert.equal(f.guard.snapshot().history.length, 1);
  f.guard.clear(ctx().key);
  f.guard.block(ctx(), 'business response mismatch', different);
  const firstResponse = f.guard.snapshot().history[0];
  assert.equal(firstResponse.source, 'response');
  f.guard.block(ctx(), 'same lock repeated', different);
  assert.equal(f.guard.snapshot().history.length, 2);
  assert.deepEqual(f.guard.snapshot().history[0], firstResponse);
});

test('new metadata mismatch history never borrows fingerprint evidence from an older locked check', async t => {
  let metadataMismatch = false;
  const f = setup(t, {probe: async () => ({text: sample, model: metadataMismatch ? different : requested}),
    analyze: () => scoring(different)});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await assert.rejects(f.guard.ensure(ctx()), {code: 'guard_blocked'});
  assert.equal(f.guard.snapshot().history[0].score, 0.94);
  metadataMismatch = true;
  await assert.rejects(f.guard.ensure(ctx(), {force: true}), {code: 'guard_blocked'});
  const latest = f.guard.snapshot().history[0];
  assert.equal(latest.source, 'manual'); assert.equal(latest.status, 'blocked');
  assert.equal(latest.prediction, different); assert.equal(latest.score, null);
  assert.equal(latest.gap, null); assert.equal(latest.rounds, 0);
  assert.equal(f.guard.snapshot().history.length, 2);
});

test('unsupported requests produce bounded terminal evidence without probes', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  await assert.rejects(f.guard.ensure(ctx({model: 'unlisted'})), {code: 'guard_unsupported'});
  await assert.rejects(f.guard.ensure(ctx({model: 'unlisted'}), {force: true}), {code: 'guard_unsupported'});
  assert.equal(f.count(), 0);
  const history = f.guard.snapshot().history;
  assert.equal(history.length, 2); assert.ok(history.every(record => record.status === 'unsupported'));
});

test('timed-out work appends one cancellation outcome even if its probes complete later', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = setup(t, {probe: async () => { await barrier; return {text: sample, model: requested}; }});
  f.guard.configure('p1', {enabled: true, ttlSeconds: 600});
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = f.guard.ensure(ctx());
  const rejected = assert.rejects(pending, {code: 'guard_unverified'});
  t.mock.timers.tick(145000); await rejected;
  const before = f.guard.snapshot().history;
  assert.equal(before.length, 1); assert.equal(before[0].status, 'unverified');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.guard.snapshot().history, before);
  assert.equal(f.guard.snapshot().records[0].status, 'unverified');
});

test('history is sanitized evidence and malformed event identities cannot become trusted state', async t => {
  const f = setup(t); f.guard.configure('p1', {enabled: true, ttlSeconds: 1800});
  await f.guard.ensure(ctx());
  const filename = path.join(f.runtime, 'model-guard.json');
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
  saved.history[0].cacheValid = true; saved.history[0].transport = {authorization: 'INJECTED_SECRET'};
  fs.writeFileSync(filename, JSON.stringify(saved));
  const loaded = createGuard(f.options);
  assert.doesNotMatch(JSON.stringify(loaded.snapshot()), /INJECTED_SECRET/);
  assert.equal(Object.hasOwn(loaded.snapshot().history[0], 'cacheValid'), false);
  assert.equal(loaded.snapshot().records[0].cacheValid, false);
  for (const invalid of [
    [{...saved.history[0], id: 'invalid'}],
    [{...saved.history[0], status: 'checking'}],
    [{...saved.history[0], source: 'unknown'}],
    [{...saved.history[0], score: 99}],
    [saved.history[0], saved.history[0]]
  ]) {
    fs.writeFileSync(filename, JSON.stringify({...saved, history: invalid}));
    const broken = createGuard(f.options);
    assert.ok(broken.snapshot().error);
    await assert.rejects(broken.ensure(ctx()), {code: 'guard_unverified'});
  }
});
