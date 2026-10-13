'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {analyzeSamples, validateEvidence} = require('./guard-evidence.cjs');
const {createGuard} = require('./guard.cjs');
const {bank, numbers, outputs} = require('./scripts/guard-fixtures.cjs');
const model = 'gpt-6-astra', alternate = 'gpt-6-luna';
const context = () => ({key: 'synthetic-key', providerId: 'synthetic-provider', providerName: 'Offline fixture', model, effort: 'high'});
function fixture(t, probe) {
  const parent = fs.realpathSync(process.env.PI_SCRATCH_DIR || os.tmpdir());
  const runtime = fs.mkdtempSync(path.join(parent, 'guard-evidence-'));
  t.after(() => {assert.equal(path.dirname(fs.realpathSync(runtime)), parent); fs.rmSync(runtime, {recursive: true, force: true});});
  const guard = createGuard({runtime, probe});
  guard.configure(context().providerId, {enabled: true, ttlSeconds: 600});
  return {runtime, guard};
}
test('unmodified scorer evaluates each sample and aggregate from synthetic histograms', () => {
  const pass = analyzeSamples(outputs(model), bank, model).evidence;
  assert.ok(validateEvidence(pass));
  assert.equal(pass.aggregate.prediction, model);
  assert.ok(pass.samples.every(sample => sample.prediction === model));
  assert.deepEqual(pass.flags, {conflictingSamples: false, repeatedSamples: false});
  const different = analyzeSamples(outputs(alternate), bank, model).evidence;
  assert.ok(validateEvidence(different));
  assert.equal(different.aggregate.prediction, alternate);
  assert.ok(different.aggregate.score >= .8 && different.aggregate.expectedScore <= .15);
  assert.equal(different.flags.conflictingSamples, true);
});
test('evidence validator rejects unbounded, extra, sparse and contradictory fields', () => {
  const evidence = analyzeSamples(outputs(model), bank, model).evidence;
  const mutate = change => {const value = structuredClone(evidence);change(value);assert.equal(validateEvidence(value), false);};
  mutate(value => value.providerSecret = 'unexpected');
  mutate(value => value.samples[0].numbers[0] = 356);
  mutate(value => value.samples[0].numbers[0] = 1.5);
  mutate(value => delete value.samples[0].numbers[0]);
  mutate(value => value.samples[0].actualCount++);
  mutate(value => value.samples[0].expectedCount = 999);
  mutate(value => value.aggregate.topCandidates[0].score = NaN);
  mutate(value => value.aggregate.topCandidates[1].model = value.aggregate.topCandidates[0].model);
  mutate(value => value.flags.conflictingSamples = true);
  mutate(value => value.flags.repeatedSamples = true);
});
test('numeric evidence persists, snapshots are independent, and restart does not trust a pass', async t => {
  let count = 0;
  const f = fixture(t, async () => ({model, text: numbers(model, count++).join(',')}));
  await f.guard.ensure(context());
  const snapshot = f.guard.snapshot();
  assert.equal(count, 3);assert.equal(snapshot.history.length, 1);
  assert.equal(snapshot.records[0].status, 'passed');assert.equal(snapshot.records[0].cacheValid, true);
  assert.ok(validateEvidence(snapshot.history[0].sampleEvidence[0]));
  snapshot.records[0].sampleEvidence[0].samples[0].numbers[0] = 355;
  snapshot.history[0].sampleEvidence[0].samples[0].numbers[1] = 355;
  assert.notDeepEqual(f.guard.snapshot().records, snapshot.records);
  const restarted = createGuard({runtime: f.runtime, probe: async () => ({model, text: numbers(model).join(',')})});
  assert.equal(restarted.snapshot().records[0].cacheValid, false);
  assert.ok(validateEvidence(restarted.snapshot().history[0].sampleEvidence[0]));
  const stored = JSON.parse(fs.readFileSync(path.join(f.runtime, 'model-guard.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(stored), /authorization|upstream|projectPrompt/);
});
test('duplicate completed sequences fail closed without rerolling samples', async t => {
  let calls = 0;
  const f = fixture(t, async () => {calls++;return {model, text: numbers(model).join(',')};});
  await assert.rejects(f.guard.ensure(context()), error => error.code === 'guard_unverified' && /重复/.test(error.message));
  assert.equal(calls, 3);assert.equal(f.guard.snapshot().history.length, 1);
  assert.equal(f.guard.snapshot().records[0].sampleEvidence[0].flags.repeatedSamples, true);
});
test('a strong individual conflict overrides an otherwise passing aggregate and revokes admission', async t => {
  let calls = 0, mixed = false;
  const f = fixture(t, async () => {
    const index = calls++;
    return {model, text: numbers(mixed && index % 3 === 2 ? alternate : model, index).join(',')};
  });
  const admitted = context();await f.guard.ensure(admitted);f.guard.assertAllowed(admitted);
  mixed = true;
  await assert.rejects(f.guard.ensure(context(), {force: true}), error => error.code === 'guard_unverified' && /样本冲突/.test(error.message));
  const record = f.guard.snapshot().records[0];
  assert.equal(record.status, 'unverified');assert.equal(record.sampleEvidence[0].aggregate.prediction, model);
  assert.equal(record.sampleEvidence[0].flags.conflictingSamples, true);
  assert.throws(() => f.guard.assertAllowed(admitted));
  assert.equal(calls, 6);assert.equal(f.guard.snapshot().history.length, 2);
});
test('two independent strong alternate rounds latch and retain both rounds', async t => {
  let calls = 0;
  const f = fixture(t, async () => ({model, text: numbers(alternate, calls++).join(',')}));
  await assert.rejects(f.guard.ensure(context()), {code: 'guard_blocked'});
  const state = f.guard.snapshot();
  assert.equal(calls, 6);assert.equal(state.history.length, 1);
  assert.equal(state.records[0].status, 'blocked');assert.equal(state.history[0].sampleEvidence.length, 2);
});
test('reusing first-round sequences cannot manufacture independent confirmation', async t => {
  let calls = 0;
  const f = fixture(t, async () => ({model, text: numbers(alternate, calls++ % 3).join(',')}));
  await assert.rejects(f.guard.ensure(context()), error => error.code === 'guard_unverified' && /首轮完全重复/.test(error.message));
  assert.equal(calls, 6);assert.equal(f.guard.snapshot().records[0].status, 'unverified');
  assert.equal(f.guard.snapshot().history.length, 1);
});
test('an incomplete confirmation preserves completed strong first-round evidence', async t => {
  let calls = 0;
  const f = fixture(t, async () => ({model, text: ++calls <= 3 ? numbers(alternate, calls - 1).join(',') : ''}));
  await assert.rejects(f.guard.ensure(context()), {code: 'guard_unverified'});
  const state = f.guard.snapshot();assert.equal(calls, 4);assert.equal(state.history.length, 1);
  assert.equal(state.records[0].sampleEvidence.length, 1);
  assert.equal(state.records[0].sampleEvidence[0].aggregate.prediction, alternate);
});
