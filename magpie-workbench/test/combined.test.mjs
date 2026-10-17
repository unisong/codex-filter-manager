import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {onRequest as original} from '../history/codex-history.middleware.js';
import {combineMiddleware} from '../server/middleware.mjs';
import {gateCode} from '../server/engine.mjs';
import {createHistoryOptions} from '../server/history-options.mjs';

async function load(code) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-module-'));
  const file = path.join(directory, 'middleware.mjs');
  try {
    fs.writeFileSync(file, code);
    return await import(pathToFileURL(file).href);
  } finally { fs.rmSync(directory, {recursive: true}); }
}
const options = {providers: {'magpie:demo': {historyFilter: true, preserveEncryptedInclude: true}}, aliases: {old: 'demo'}};
const body = {model: 'demo/gpt-6-astra', include: ['reasoning.encrypted_content'], input: [
  {type: 'reasoning', encrypted_content: 'OLD'},
  {type: 'message', id: 'msg_old', role: 'user', content: [{type: 'input_text', text: 'KEEP'}]},
  {type: 'function_call', id: 'fc_old', call_id: 'pair', name: 'echo', arguments: '{}'},
  {type: 'function_call_output', id: 'fo_old', call_id: 'pair', output: 'KEEP_RESULT'},
]};
function invoke(hook, request, extra = {}) {
  let rejected;
  const result = hook(request, {protocol: 'responses', path: '/v1/responses', options,
    ...extra, reject: (...args) => { rejected = args; }});
  return {result, rejected};
}
test('combined entry preserves standalone filter results, aliases, rejections and nonmutation', async () => {
  const combined = await load(combineMiddleware());
  for (const request of [body, {...body, model: 'old/gpt-6-astra'}, {...body, model: 'backup/gpt-6-astra'},
    {...body, previous_response_id: 'resp_old'}, {...body, input: [{type: 'item_reference', id: 'old'}]},
    {...body, input: [{type: 'compaction', encrypted_content: 'old'}]}, {...body, include: 'invalid'}]) {
    const before = JSON.stringify(request);
    for (const ctx of [{}, {path: '/v1/responses/compact'}, {protocol: 'chat-completions'}])
      assert.deepEqual(invoke(combined.onRequest, request, ctx), invoke(original, request, ctx));
    assert.equal(JSON.stringify(request), before);
  }
});
test('combined protection pauses exactly one model; probe alias resolves before history filtering', async () => {
  const code = combineMiddleware(gateCode([{model: body.model, mode: 'protect', paused: true}], 'test-secret'));
  const {onRequest} = await load(code);
  assert.equal(invoke(onRequest, body).rejected[0], 409);
  const backup = {...body, model: 'backup/gpt-6-astra'};
  assert.deepEqual(invoke(onRequest, backup), invoke(original, backup));
  const probe = invoke(onRequest, {...body, model: 'workbench-probe/test-secret/' + body.model});
  assert.equal(probe.rejected, undefined);
  assert.equal(probe.result.model, body.model);
  assert.equal(probe.result.input.length, 3);
  assert.equal(probe.result.input[0].id, undefined);
  assert.equal(probe.result.input[1].call_id, 'pair');
});
test('runtime protection failure does not bypass history filtering', async () => {
  const combined = await load(combineMiddleware('export function onRequest(){throw Error("detector failure")}'));
  assert.deepEqual(invoke(combined.onRequest, body), invoke(original, body));
});
test('console edits only its filter switches, preserves other plugins/private options, detects conflicts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-options-'));
  const packageRoot = path.join(root, 'package'), file = path.join(root, 'plugins.json');
  const config = {plugins: [{spec: 'other-plugin', options: {secret: 'PRIVATE_OTHER'}},
    {spec: packageRoot, options: {...options, gatewayKey: 'PRIVATE_OWN', custom: {keep: true}}}], prefer: {keep: 'other-plugin'}};
  fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify({providers: [
    {id: 'demo', name: 'Demo', key: 'PRIVATE_PROVIDER'},
    {id: 'deleted-provider', name: '', hidden: true, key: 'PRIVATE_HIDDEN'}]}));
  const store = createHistoryOptions({magpieDirectory: root, packageRoot});
  const before = store.get();
  assert.ok(!JSON.stringify(before).includes('PRIVATE'));
  assert.deepEqual(before.providers, [{id: 'demo', name: 'Demo'}]);
  assert.deepEqual(globalThis.HistorySettings.rows(before.options, [
    {id: 'demo', name: 'Demo'}, {id: 'deleted-provider', name: '', hidden: true}])
    .map(row => row.id), ['demo'], 'hidden provider tombstones are not filter targets');
  const draft = structuredClone(before.options); draft.providers['magpie:demo'].historyFilter = false;
  store.save({base: before.options, draft});
  const saved = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(saved.plugins[0], config.plugins[0]); assert.deepEqual(saved.prefer, config.prefer);
  assert.equal(saved.plugins[1].options.gatewayKey, 'PRIVATE_OWN');
  assert.deepEqual(saved.plugins[1].options.custom, {keep: true});
  assert.equal(saved.plugins[1].options.providers['magpie:demo'].historyFilter, false);
  assert.throws(() => store.save({base: before.options, draft: {...draft, gatewayKey: 'evil'}}));
  const fresh = store.get().options, stale = structuredClone(fresh);
  stale.providers['magpie:demo'].preserveEncryptedInclude = false;
  saved.plugins[1].options.aliases = {old: 'backup'}; fs.writeFileSync(file, JSON.stringify(saved));
  assert.throws(() => store.save({base: fresh, draft: stale}), /其他窗口/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), saved);
  fs.rmSync(root, {recursive: true});
});

test('local workbench installations are recognized while duplicate copies are rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-published-'));
  try {
    const file = path.join(root, 'plugins.json');
    for (const spec of ['github:unisong/magpie-model-workbench#v1.0.7', 'magpie-model-workbench',
      'magpie-model-workbench@1.0.7', path.join(root, 'cache')]) {
      fs.writeFileSync(file, JSON.stringify({plugins: [{spec, options}]}));
      const store = createHistoryOptions({magpieDirectory: root, packageRoot: path.join(root, 'cache')});
      const before = store.get();
      const draft = structuredClone(before.options); draft.providers['magpie:demo'].historyFilter = false;
      store.save({base: before.options, draft});
      assert.equal(JSON.parse(fs.readFileSync(file)).plugins[0].options.providers['magpie:demo'].historyFilter, false);
      fs.writeFileSync(file, JSON.stringify({plugins: [{spec, options}, {spec: 'magpie-model-workbench', options}]}));
      assert.throws(() => store.get(), /唯一确定/);
    }
    for (const spec of ['@magpie-community/middleware-codex-history',
      'github:unisong/magpie-codex-history-filter#v0.1.1']) {
      const config = {plugins: [{spec, options}]};
      fs.writeFileSync(file, JSON.stringify(config));
      const store = createHistoryOptions({magpieDirectory: root, packageRoot: path.join(root, 'cache')});
      assert.throws(() => store.get(), /唯一确定/);
      assert.deepEqual(JSON.parse(fs.readFileSync(file)), config);
    }
  } finally { fs.rmSync(root, {recursive: true}); }
});
