import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createEngine} from '../server/engine.mjs';

const input = {model: 'demo/gpt-6-astra', expected: 'gpt-6-astra', effort: 'low', mode: 'observe', intervalMinutes: 5};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
  assert.fail('condition did not settle');
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-schedule-'));
  return {directory, gateFile: path.join(directory, 'gate.middleware.js'), tickMs: 5, gateway: () => ({url: 'http://127.0.0.1:1'})};
}
const abortingProbe = ({signal}) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), {once: true}));

test('stop aborts the active batch, prevents future rounds and survives edits/restart without releasing holds', async () => {
  const f = fixture(); let now = 1000000, calls = 0;
  const options = {...f, now: () => now, probe: args => { calls++; return abortingProbe(args); }};
  let e = createEngine(options);
  try {
    const t = e.update({...input, mode: 'protect'});
    e.action(t.id, 'pause'); e.action(t.id, 'allow');
    const allowance = e.snapshot().targets[0].allowUntil, gateBefore = fs.readFileSync(f.gateFile, 'utf8');
    now = t.nextAt; await until(() => calls === 1);
    e.schedule(t.id, 'stop');
    assert.equal(e.snapshot().targets[0].stopping, true);
    assert.equal(e.snapshot().targets[0].scheduleEnabled, false);
    assert.equal(e.snapshot().targets[0].nextAt, 0);
    assert.equal(fs.readFileSync(f.gateFile, 'utf8'), gateBefore, 'stop must not change published rules');
    assert.throws(() => e.schedule(t.id, 'start'), /正在取消/);
    await until(() => !e.snapshot().targets[0].running);
    const record = e.snapshot().history[0];
    assert.equal(record.status, 'cancelled'); assert.equal(record.requests, 1);
    assert.equal(e.snapshot().history.length, 1); assert.equal(e.snapshot().daily.used, 1);
    assert.equal(e.snapshot().targets[0].paused, true); assert.equal(e.snapshot().targets[0].allowUntil, allowance);
    now += 10 * 60000; await delay(20); assert.equal(calls, 1);
    e.update({...input, id: t.id, mode: 'protect', intervalMinutes: 20});
    assert.equal(e.snapshot().targets[0].scheduleEnabled, false, 'save must not rearm a stopped target');
    await e.close(); e = createEngine(options);
    assert.equal(e.snapshot().targets[0].scheduleEnabled, false); assert.equal(e.snapshot().targets[0].nextAt, 0);
    assert.equal(e.snapshot().targets[0].paused, true); assert.equal(e.snapshot().targets[0].allowUntil, allowance);
    await delay(20); assert.equal(calls, 1);
    e.schedule(t.id, 'start'); const nextAt = now + 20 * 60000;
    assert.equal(e.snapshot().targets[0].nextAt, nextAt);
    e.schedule(t.id, 'start'); assert.equal(e.snapshot().targets[0].nextAt, nextAt, 'duplicate resume does not postpone the next round');
    now = nextAt - 1; await delay(20); assert.equal(calls, 1);
    now++; await until(() => calls === 2);
    e.schedule(t.id, 'stop'); await until(() => !e.snapshot().targets[0].running);
  } finally { await e.close(); fs.rmSync(f.directory, {recursive: true}); }
});

test('stop-all includes manual jobs, is idempotent, and leaves one-target stop isolated', async () => {
  const f = fixture(); let calls = 0;
  const e = createEngine({...f, probe: args => { calls++; return abortingProbe(args); }});
  try {
    const a = e.update(input), b = e.update({...input, model: 'other/gpt-6-astra'}), manual = e.update({...input, model: 'manual/gpt-6-astra', mode: 'manual'});
    e.start(a.id); e.start(manual.id); e.schedule(b.id, 'stop');
    assert.equal(e.snapshot().targets.find(t => t.id === a.id).scheduleEnabled, true);
    assert.equal(e.snapshot().targets.find(t => t.id === b.id).scheduleEnabled, false);
    e.schedule(undefined, 'stop'); e.schedule(undefined, 'stop');
    await until(() => e.snapshot().targets.every(t => !t.running));
    assert.ok(e.snapshot().targets.every(t => !t.scheduleEnabled && t.nextAt === 0));
    assert.equal(calls, 2); assert.equal(e.snapshot().history.length, 2);
    assert.throws(() => e.start(a.id, 'scheduled'), /已停止/);
    e.start(a.id); assert.equal(calls, 3, 'one-off checks remain available after a schedule stop');
    e.action(a.id, 'cancel'); await until(() => !e.snapshot().targets.find(t => t.id === a.id).running);
    assert.equal(e.snapshot().targets.find(t => t.id === a.id).scheduleEnabled, false);
    assert.throws(() => e.schedule(manual.id, 'start'), /先为此目标设置/);
    for (const [id, op] of [[null, 'stop'], ['', 'stop'], [undefined, 'start'], [a.id, 'anything']]) assert.throws(() => e.schedule(id, op), /操作无效/);
    assert.throws(() => e.schedule('missing', 'stop'), /不存在/);
  } finally { await e.close(); fs.rmSync(f.directory, {recursive: true}); }
});

test('cancel-only retains scheduling; stopping during retry backoff sends no retries', async () => {
  const f = fixture(); let calls = 0, waiting = false;
  const e = createEngine({...f, probe: async () => { calls++; throw Object.assign(Error('429'), {code: 'guard_unverified', retryable: true}); },
    wait: (ms, value, {signal}) => { waiting = true; return abortingProbe({signal}); }});
  try {
    const t = e.update(input); e.start(t.id); await until(() => waiting);
    e.action(t.id, 'cancel'); await until(() => !e.snapshot().targets[0].running);
    assert.equal(e.snapshot().targets[0].scheduleEnabled, true);
    assert.ok(e.snapshot().targets[0].nextAt > 0);
    waiting = false; e.start(t.id); await until(() => waiting);
    e.schedule(t.id, 'stop'); await until(() => !e.snapshot().targets[0].running);
    assert.equal(calls, 2); assert.equal(e.snapshot().targets[0].nextAt, 0);
    assert.equal(e.snapshot().history[0].requests, 1);
  } finally { await e.close(); fs.rmSync(f.directory, {recursive: true}); }
});

test('old state retains its opt-in; malformed scheduling state does not replace an existing gate', async () => {
  const f = fixture(); let e = createEngine(f);
  try {
    const t = e.update(input); await e.close();
    const file = path.join(f.directory, 'state.json'), saved = JSON.parse(fs.readFileSync(file));
    delete saved.targets[0].scheduleEnabled; fs.writeFileSync(file, JSON.stringify(saved));
    e = createEngine(f); assert.equal(e.snapshot().targets[0].scheduleEnabled, true);
    e.schedule(t.id, 'stop'); await e.close();
    const stopped = JSON.parse(fs.readFileSync(file)); stopped.targets[0].scheduleEnabled = 'false'; fs.writeFileSync(file, JSON.stringify(stopped));
    const before = fs.readFileSync(f.gateFile, 'utf8'); e = createEngine(f);
    assert.ok(e.snapshot().health); assert.equal(fs.readFileSync(f.gateFile, 'utf8'), before);
  } finally { await e.close(); fs.rmSync(f.directory, {recursive: true}); }
});
