import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {createCurrentModel, routeFromUsage} from '../server/current-model.mjs';

const now = Date.now() - 10000;
const row = (offset = 0, fields = {}) => ({t: new Date(now + offset).toISOString(), agent: 'codex',
  provider: 'demo', model: 'gpt-6-astra', req: 'group/coding', served: 'gpt-6-luna', effort: 'high', ...fields});

test('auto selection uses actual gateway route, not upstream declarations or account metadata', () => {
  const current = routeFromUsage([row(-1000), row(0, {account: 'PRIVATE', key: 'SECRET', session: 'PRIVATE'})]);
  assert.equal(current.model, 'demo/gpt-6-astra');
  assert.equal(current.requestedModel, 'group/coding');
  assert.equal(current.reportedModel, 'gpt-6-luna');
  assert.equal(current.effort, 'high');
  assert.equal(current.source, 'request');
  assert.ok(!JSON.stringify(current).includes('PRIVATE'));
  assert.ok(!JSON.stringify(current).includes('SECRET'));
});

test('auxiliary, remote, rejected and detector records cannot replace the business model', () => {
  const excluded = [{agent: 'unknown'}, {kind: 'title'}, {source: 'reported'}, {computer: 'other'},
    {via: 'other'}, {rejected: true}, {handed_on: true}, {req: 'workbench-probe/secret/demo/gpt-6-astra', agent: ''},
    {t: 'invalid'}, {t: new Date(Date.now() + 120000).toISOString()}, {provider: 'invalid/name'}];
  assert.equal(routeFromUsage([row(-2000), ...excluded.map(f => row(1000, f))]).observedAt, row(-2000).t);
  const probes = [{model: 'demo/gpt-6-astra', rounds: [{samples: [{attempts: [{startedAt: now - 500, finishedAt: now + 500}]}]}]}];
  assert.equal(routeFromUsage([row(), row(-2000)], probes).observedAt, row(-2000).t);
  assert.equal(routeFromUsage([row()], probes), null);
});

test('official usage reader coalesces polls and falls back to newest history without model calls', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-route-'));
  let reads = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.match(req.url, /^\/v1\/magpie\/usage\/requests\?/);
    reads++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({rows: [row()]}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const reader = createCurrentModel({gateway: () => ({url: 'http://127.0.0.1:' + server.address().port}), magpieDirectory: directory, history: () => []});
    const values = await Promise.all([reader(), reader(), reader()]);
    assert.ok(values.every(v => v.model === 'demo/gpt-6-astra')); assert.equal(reads, 1);
    await reader(); assert.equal(reads, 1);
    const fallback = createCurrentModel({gateway: () => ({url: 'http://127.0.0.1:1'}), magpieDirectory: directory,
      history: () => [{model: 'bad/model', startedAt: 'invalid'}, {model: 'old/model', startedAt: 1000}, {model: 'new/model', startedAt: 2000}]});
    assert.equal((await fallback()).model, 'new/model');
    fs.writeFileSync(path.join(directory, 'usage.jsonl'), 'malformed\n' + JSON.stringify(row()));
    const legacy = createCurrentModel({gateway: () => ({url: 'http://127.0.0.1:1'}), magpieDirectory: directory, history: () => []});
    assert.equal((await legacy()).source, 'request');
  } finally { await new Promise(r => server.close(r)); fs.rmSync(directory, {recursive: true}); }
});

test('both workbenches share theme, icon and model-selection contract byte for byte', () => {
  const cc = new URL('../../codex-filter-manager/', import.meta.url);
  // A standalone Magpie archive need not contain its sibling CC repository.
  if (fs.existsSync(cc)) for (const [magpie, ccs] of [['web/workbench-theme.css', 'assets/workbench-theme.css'],
    ['web/current-selection.js', 'assets/current-selection.js'], ['web/icon.svg', 'assets/favicon.svg']]) {
    assert.deepEqual(fs.readFileSync(new URL('../' + magpie, import.meta.url)), fs.readFileSync(new URL(ccs, cc)));
  }
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../web/current-selection.js', import.meta.url), 'utf8'), context);
  const select = context.WorkbenchSelection;
  const history = [{model: 'old', checkedAt: '2026-01-01'}, {model: 'new', checkedAt: '2026-02-01'}];
  assert.equal(select({current: {model: 'actual', source: 'request'}, history}).model, 'actual');
  assert.equal(select({history, configured: {model: 'config'}}).model, 'new');
  assert.equal(select({history: []}), null);
});
