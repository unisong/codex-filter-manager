import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {createEngine, assess} from '../server/engine.mjs';
import {parseNumbers} from '../vendor/modeltrace/fingerprint-core.mjs';
const require = createRequire(import.meta.url);
const {analyzeSamples} = require('../server/evidence.cjs');
const bank = JSON.parse(fs.readFileSync(new URL('../vendor/modeltrace/unified_bank.json', import.meta.url)));
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-test-'));
  return {directory, gateFile: path.join(directory, 'gate.middleware.js')};
}
const input = {model: 'demo/gpt-6-astra', expected: 'gpt-6-astra', effort: 'low', mode: 'manual', intervalMinutes: 30};
const numeric = (n = 320, variant = 0) => Array.from({length: n}, (_, i) => ((i * (31 + variant * 2) + variant * 13) % 355) + 1).join(',');
async function settled(engine, id) {
  for (let i = 0; i < 100; i++) { if (!engine.snapshot().targets.find(t => t.id === id)?.running) return; await new Promise(r => setTimeout(r, 10)); }
  throw Error('job did not settle');
}
test('no probes on startup or manual target save; history hook is not involved', async () => {
  const f = fixture(); let calls = 0;
  const e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'}), probe: async () => { calls++; }});
  e.update(input);
  assert.equal(e.snapshot().targets[0].mode, 'manual'); assert.equal(calls, 0);
  assert.deepEqual(e.snapshot().history, []);
  await e.close(); fs.rmSync(f.directory, {recursive: true});
});
test('actual reference IDs must be selected, aliases are never guessed', async () => {
  const f = fixture(), e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'})});
  assert.ok(e.snapshot().candidates.includes(input.expected));
  assert.throws(() => e.update({...input, expected: 'made-up-model'}), /期望模型/);
  assert.throws(() => e.update({...input, model: 'luna'}), /完整/);
  assert.throws(() => e.update({...input, model: 'group/default', mode: 'protect'}), /路由组/);
  await e.close(); fs.rmSync(f.directory, {recursive: true});
});
test('whole check shares at most three retries; history keeps one record and attempts', async () => {
  const f = fixture(); let calls = 0;
  const e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'}), wait: async () => {},
    probe: async () => { calls++; throw Object.assign(Error('上游限流'), {code: 'guard_unverified', retryable: true}); }});
  const t = e.update(input); const id = e.start(t.id); assert.equal(e.start(t.id), id);
  await settled(e, t.id);
  assert.equal(calls, 4); assert.equal(e.snapshot().daily.used, 4);
  assert.equal(e.snapshot().history.length, 1);
  const record = e.record(id); assert.equal(record.status, 'incomplete');
  assert.equal(record.rounds[0].samples[0].attempts.length, 4);
  assert.equal(e.snapshot().targets[0].paused, false);
  await e.close(); fs.rmSync(f.directory, {recursive: true});
});
test('gateway errors and invalid samples never become model-deviation verdicts', async () => {
  for (const response of ['not numbers', numeric()]) {
    const f = fixture();
    const e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'}),
      probe: async () => ({text: response, model: 'gpt-6-astra'})});
    const t = e.update({...input, mode: 'protect'}); e.start(t.id); await settled(e, t.id);
    const state = e.snapshot();
    if (response === 'not numbers') assert.equal(state.history[0].status, 'incomplete');
    else assert.notEqual(state.history[0].status, 'matched', 'identical samples must not pass');
    assert.equal(state.targets[0].paused, false);
    assert.ok(!JSON.stringify(state).includes('not numbers'), 'summary omits raw answers');
    await e.close(); fs.rmSync(f.directory, {recursive: true});
  }
});
test('gate pauses one complete model; signed probes bypass it without changing business history', async () => {
  const f = fixture(), e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'})});
  const t = e.update({...input, mode: 'protect'}); e.action(t.id, 'pause');
  const code = fs.readFileSync(f.gateFile, 'utf8');
  const moduleFile = path.join(f.directory, 'test-gate.mjs');
  fs.writeFileSync(moduleFile, code);
  const mod = await import(pathToFileURL(moduleFile).href);
  const history = [{type: 'reasoning', encrypted_content: 'keep-original'}];
  let rejected;
  mod.onRequest({model: input.model, input: history}, {reject: (...args) => { rejected = args; }});
  assert.equal(rejected[0], 409);
  rejected = undefined;
  assert.equal(mod.onRequest({model: 'backup/gpt-6-astra', input: history}, {reject: () => assert.fail('other model blocked')}), undefined);
  const bypass = JSON.parse(/const bypass=("[^"]+")/.exec(code)[1]);
  const result = mod.onRequest({model: bypass + input.model, input: history}, {reject: () => assert.fail('probe blocked')});
  assert.equal(result.model, input.model); assert.equal(result.input, history);
  e.action(t.id, 'allow');
  assert.ok(e.snapshot().targets[0].allowUntil > Date.now());
  e.action(t.id, 'resume'); assert.equal(e.snapshot().targets[0].paused, false);
  await e.close(); fs.rmSync(f.directory, {recursive: true});
});
test('route change aborts check, cancellation settles one history entry and never revives pass', async () => {
  const f = fixture(); let route = 'a';
  const e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'}), routeVersion: () => route,
    probe: async () => { route = 'b'; return {text: numeric(), model: input.expected}; }});
  const t = e.update(input); e.start(t.id); await settled(e, t.id);
  assert.equal(e.snapshot().history[0].status, 'incomplete');
  assert.match(e.snapshot().history[0].reason, /路由/);
  await e.close(); fs.rmSync(f.directory, {recursive: true});
});
test('budget survives restart; interrupted job becomes incomplete without auto retry', async () => {
  const f = fixture();
  const e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'}), probe: async () => { throw Object.assign(Error('403'), {code: 'guard_unverified'}); }});
  const t = e.update(input); e.start(t.id); await settled(e, t.id);
  e.budget(3); await e.close();
  const before = JSON.parse(fs.readFileSync(path.join(f.directory, 'state.json')));
  before.history[0].status = 'running'; fs.writeFileSync(path.join(f.directory, 'state.json'), JSON.stringify(before));
  const next = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'}), probe: () => assert.fail('restart sent request')});
  assert.equal(next.snapshot().daily.used, 1); assert.equal(next.snapshot().history[0].status, 'incomplete');
  assert.throws(() => next.start(t.id), /预算/);
  await next.close(); fs.rmSync(f.directory, {recursive: true});
});
test('manual pause survives an incomplete check and detection does not alter history filtering', async () => {
  const f = fixture(), e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'}),
    probe: async () => ({text: 'invalid', model: input.expected})});
  const t = e.update({...input, mode: 'protect'}); e.action(t.id, 'pause'); e.start(t.id); await settled(e, t.id);
  assert.equal(e.snapshot().targets[0].paused, true);
  assert.equal(e.snapshot().targets[0].pauseReason, '人工暂停');
  await e.close(); fs.rmSync(f.directory, {recursive: true});
});
test('scoring distinguishes individual conflict from aggregate fit and repeated outputs', () => {
  const s = (prediction, score, expectedScore) => ({prediction, score, expectedScore});
  const matched = {aggregate: s(input.expected, .9, .9), samples: [s(input.expected,.8,.8)], flags: {repeatedSamples: false, conflictingSamples: false}};
  assert.equal(assess(matched, input.expected), 'matched');
  assert.equal(assess({...matched, flags: {...matched.flags, conflictingSamples: true}}, input.expected), 'suspect');
  assert.equal(assess({...matched, flags: {...matched.flags, repeatedSamples: true}}, input.expected), 'suspect');
  assert.equal(assess({aggregate: s('gpt-6-luna',.99,.01), samples: [s('gpt-6-luna',.99,.01),s('gpt-6-luna',.98,.02)], flags: {}}, input.expected), 'difference');
});
test('upstream scorer handles real numeric fixtures through the independent evidence layer', () => {
  const outputs = [0,1,2].map(v => ({text: numeric(320,v), expected_count: 320}));
  const {evidence} = analyzeSamples(outputs, bank, input.expected);
  assert.equal(evidence.samples.length, 3); assert.equal(parseNumbers(outputs[0].text).length, 320);
  assert.equal(evidence.flags.repeatedSamples, false);
});

function referenceNumbers(model, index) {
  const entry = bank.models.find(m => m.id === model), total = entry.counts.reduce((a,b) => a+b, 0);
  const values = Array.from({length: 300}, (_, p) => {
    let q = (p + (index % 3 + 1) / 7) / 300 * total;
    for (let bin = 0; bin < entry.counts.length; bin++) { q -= entry.counts[bin]; if (q < 0) return bin + 1; }
    return 355;
  });
  const offset = Math.floor(index / 3) % values.length;
  return values.slice(offset).concat(values.slice(0, offset)).join(',');
}
test('two independent Luna-like batches pause only the opted-in Astra target; a later match never silently resumes', async () => {
  const f = fixture(); let n = 0, fixtureModel = 'gpt-6-luna';
  const e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'}),
    probe: async () => ({text: referenceNumbers(fixtureModel,n++), model: input.expected})});
  const t = e.update({...input, mode: 'protect'}); const id = e.start(t.id); await settled(e, t.id);
  const r = e.record(id);
  assert.equal(r.status, 'deviated'); assert.equal(r.rounds.length, 2); assert.equal(r.requests, 6);
  assert.equal(e.snapshot().targets[0].paused, true);
  fixtureModel = input.expected; e.start(t.id); await settled(e, t.id);
  assert.equal(e.snapshot().history[0].status, 'matched'); assert.equal(e.snapshot().targets[0].paused, true);
  e.action(t.id, 'resume'); assert.equal(e.snapshot().targets[0].paused, false);
  await e.close(); fs.rmSync(f.directory, {recursive: true});
});
test('corrupt state does not replace a previously published gate', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.directory,'state.json'), '{bad');
  fs.writeFileSync(f.gateFile, 'old-gate');
  const e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'})});
  assert.ok(e.snapshot().health); assert.equal(fs.readFileSync(f.gateFile,'utf8'), 'old-gate');
  assert.throws(() => e.update(input), /状态文件/);
  await e.close(); fs.rmSync(f.directory, {recursive: true});
});
test('closing cancels in-flight work; duplicate checks and edits do not race', async () => {
  const f = fixture();
  const e = createEngine({...f, gateway: () => ({url: 'http://127.0.0.1:1'}), probe: ({signal}) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), {once: true}))});
  const t = e.update(input); const id = e.start(t.id);
  assert.equal(e.start(t.id),id); assert.throws(() => e.update({...input,id:t.id}), /正在检测/);
  await e.close(); assert.equal(e.record(id).status,'cancelled');
  fs.rmSync(f.directory, {recursive: true});
});
