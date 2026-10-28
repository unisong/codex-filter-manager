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
test('DeepSeek protocol compatibility is explicit per provider; no provider ID is enabled implicitly', async () => {
  const {onProvider} = await load(combineMiddleware());
  const providerOptions = {providers: {'magpie:strict-deepseek': {
    historyFilter: false, preserveEncryptedInclude: true, deepSeekObjectRoot: true
  }}, aliases: {}};
  const request = {model: 'strict-deepseek/deepseek-v4.1-flash', tools: [{
    type: 'namespace', name: 'codex_app', tools: [{
      type: 'function', name: 'automation_update', parameters: {
        anyOf: [
          {type: 'object', properties: {
            mode: {type: 'string', enum: ['view']},
            id: {type: 'string'},
          }, required: ['mode', 'id']},
          {$ref: '#/$defs/update'},
          {type: 'null'},
        ],
        $defs: {update: {type: 'object', properties: {
          mode: {type: 'string', enum: ['create', 'update', 'delete']},
          name: {type: 'string'}, prompt: {type: 'string'}, rrule: {type: 'string'},
        }, required: ['mode', 'name', 'prompt', 'rrule']}},
      },
    }],
  }]};
  const untouched = structuredClone(request);
  for (const id of ['another', 'deepseek', 'strict-deepseek']) {
    assert.equal(onProvider(untouched, {provider: {id, model: 'deepseek-v4.1-flash'}}), undefined, id);
  }
  assert.equal(untouched.tools[0].tools[0].parameters.type, undefined);

  const missingRequest = structuredClone(request);
  const missingOptions = {providers: {'magpie:strict-deepseek': {historyFilter: false}}, aliases: {}};
  assert.equal(onProvider(missingRequest, {provider: {id: 'strict-deepseek', model: 'deepseek-v4.1-flash'},
    options: missingOptions}), undefined, 'a rule without the field leaves Schema compatibility off');
  assert.equal(missingRequest.tools[0].tools[0].parameters.type, undefined);
  const disabledRequest = structuredClone(request);
  assert.equal(onProvider(disabledRequest, {provider: {id: 'strict-deepseek', model: 'deepseek-v4.1-flash'},
    options: {providers: {'magpie:strict-deepseek': {deepSeekObjectRoot: false}}, aliases: {}}}), undefined);
  assert.equal(disabledRequest.tools[0].tools[0].parameters.type, undefined);
  const out = onProvider(request, {provider: {id: 'strict-deepseek', model: 'deepseek-v4.1-flash'},
    options: providerOptions});
  assert.equal(out, request);
  const schema = out.tools[0].tools[0].parameters;
  assert.equal(schema.type, 'object');
  assert.equal(schema.anyOf, undefined);
  assert.deepEqual(Object.keys(schema.properties).sort(),
    ['id', 'mode', 'name', 'prompt', 'rrule']);
  assert.deepEqual(schema.required, ['mode']);
  assert.equal(onProvider(out, {provider: {id: 'strict-deepseek', model: 'deepseek-v4.1-flash'},
    options: providerOptions}), undefined);
});
test('resumed and Lite sessions repair opted-in historical declarations without rewriting tool results', async () => {
  const {onProvider} = await load(combineMiddleware());
  const providerOptions = {providers: {'magpie:group': {
    historyFilter: false, deepSeekObjectRoot: true
  }}, aliases: {'deepseek-old': 'group'}};
  const schema = () => ({oneOf: [{$ref: '#/$defs/view'}, {$ref: '#/$defs/changes'}], $defs: {
    view: {type: 'object', properties: {mode: {const: 'view'}, id: {type: 'string'}}, required: ['mode', 'id']},
    changes: {oneOf: [
      {type: 'object', properties: {mode: {const: 'create'}, prompt: {type: 'string'}}, required: ['mode', 'prompt']},
      {type: 'object', properties: {mode: {const: 'update'}, id: {type: 'string'}}, required: ['mode', 'id']},
    ]},
  }});
  const namespace = {type: 'namespace', name: 'codex_app', tools: [
    {type: 'function', name: 'automation_update', strict: false, parameters: schema()},
  ]};
  for (const type of ['tool_search_output', 'additional_tools']) {
    for (const tools of [undefined, [], [{type: 'tool_search', execution: 'client'}]]) {
      const request = JSON.parse(JSON.stringify({model: 'group/deepseek-dedicated', tools, input: [
        {type, call_id: 'search_pair', tools: [namespace]},
        {type: 'function_call_output', call_id: 'result_pair', output: JSON.stringify(namespace), tools: [namespace]},
        {role: 'user', content: 'KEEP_HISTORY'},
      ]}));
      const before = structuredClone(request);
      assert.equal(onProvider(request, {provider: {id: 'other', model: 'deepseek-v4.1-flash'}}), undefined);
      assert.equal(onProvider(request, {provider: {id: 'group', model: 'glm-5.3'}, options: providerOptions}), undefined,
        'an opted-in provider still leaves non-DeepSeek models unchanged');
      const missingRequest = structuredClone(request);
      assert.equal(onProvider(missingRequest, {provider: {id: 'group', model: 'deepseek-v4.1-flash'},
        options: {providers: {'magpie:group': {historyFilter: false}}}}), undefined);
      assert.deepEqual(missingRequest, before);
      const disabledRequest = structuredClone(request);
      assert.equal(onProvider(disabledRequest, {provider: {id: 'group', model: 'deepseek-v4.1-flash'},
        options: {providers: {'magpie:group': {deepSeekObjectRoot: false}}}}), undefined);
      assert.deepEqual(disabledRequest, before);
      assert.deepEqual(request, before);
      const out = onProvider(request, {provider: {id: 'group', model: 'deepseek-v4.1-flash'},
        options: providerOptions});
      const fixed = out.input[0].tools[0].tools[0].parameters;
      assert.equal(fixed.type, 'object');
      assert.equal(fixed.oneOf, undefined);
      assert.deepEqual(Object.keys(fixed.properties).sort(), ['id', 'mode', 'prompt']);
      assert.deepEqual(fixed.required, ['mode']);
      assert.deepEqual(fixed.$defs, schema().$defs, 'shared definitions stay intact');
      assert.deepEqual(out.input.slice(1), before.input.slice(1), 'ordinary tool results and messages stay intact');
      assert.equal(out.input[0].call_id, 'search_pair');
      assert.deepEqual(out.tools, before.tools);
      assert.equal(onProvider(out, {provider: {id: 'group', model: 'deepseek-v4.1-flash'},
        options: providerOptions}), undefined);
    }
  }
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

test('console exposes and saves independent DeepSeek schema compatibility', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-schema-option-'));
  const packageRoot = path.join(root, 'package'), file = path.join(root, 'plugins.json');
  try {
    const config = {plugins: [{spec: packageRoot, options: {providers: {
      'magpie:demo': {historyFilter: false, deepSeekObjectRoot: true}
    }, aliases: {}}}]};
    fs.writeFileSync(file, JSON.stringify(config));
    fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify({providers: [
      {id: 'demo', name: 'Demo'}]}));
    const store = createHistoryOptions({magpieDirectory: root, packageRoot});
    const before = store.get().options;
    assert.equal(before.providers['magpie:demo'].deepSeekObjectRoot, true);
    const draft = structuredClone(before);
    draft.providers['magpie:demo'].historyFilter = true;
    store.save({base: before, draft});
    const saved = JSON.parse(fs.readFileSync(file));
    assert.equal(saved.plugins[0].options.providers['magpie:demo'].historyFilter, true);
    assert.equal(saved.plugins[0].options.providers['magpie:demo'].deepSeekObjectRoot, true);
  } finally { fs.rmSync(root, {recursive: true}); }
});

test('console keeps a Schema-only rule as saved and adds history defaults only when history is enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-schema-only-'));
  const packageRoot = path.join(root, 'package'), file = path.join(root, 'plugins.json');
  try {
    const original = {plugins: [{spec: packageRoot, options: {providers: {
      'magpie:strict-deepseek': {deepSeekObjectRoot: true}}, aliases: {}}}]};
    fs.writeFileSync(file, JSON.stringify(original));
    fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify({providers: [
      {id: 'strict-deepseek', name: 'Strict DeepSeek'}, {id: 'demo', name: 'Demo'}]}));
    const store = createHistoryOptions({magpieDirectory: root, packageRoot});
    const before = store.get().options;
    assert.deepEqual(before.providers['magpie:strict-deepseek'], {deepSeekObjectRoot: true});
    store.save({base: before, draft: before});
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), original, 'saving without edits never rewrites rules');
    store.save({base: before, draft: globalThis.HistorySettings.change(before, 'strict-deepseek', 'historyFilter', true)});
    const saved = JSON.parse(fs.readFileSync(file)).plugins[0].options.providers;
    assert.deepEqual(saved['magpie:strict-deepseek'],
      {deepSeekObjectRoot: true, historyFilter: true, preserveEncryptedInclude: true});
    assert.equal(saved['magpie:demo'], undefined);
  } finally { fs.rmSync(root, {recursive: true}); }
});

test('a history-only rule never enables DeepSeek schema compatibility in the request hook', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-history-only-'));
  const packageRoot = path.join(root, 'package'), file = path.join(root, 'plugins.json');
  try {
    fs.writeFileSync(file, JSON.stringify({plugins: [{spec: packageRoot, options: {providers: {}, aliases: {}}}]}));
    fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify({providers: [
      {id: 'strict-deepseek', name: 'Strict DeepSeek'}]}));
    const store = createHistoryOptions({magpieDirectory: root, packageRoot});
    const before = store.get().options;
    const draft = globalThis.HistorySettings.change(before, 'strict-deepseek', 'historyFilter', true);
    store.save({base: before, draft});
    const saved = JSON.parse(fs.readFileSync(file)).plugins[0].options.providers['magpie:strict-deepseek'];
    assert.deepEqual(saved, {historyFilter: true, preserveEncryptedInclude: true});
    const {onProvider} = await load(combineMiddleware());
    const request = () => ({tools: [{type: 'function', name: 'automation_update', parameters: {
      oneOf: [{type: 'object', properties: {mode: {type: 'string'}}}]
    }}]});
    const context = () => ({provider: {id: 'strict-deepseek', model: 'deepseek-v4.1-flash'},
      options: JSON.parse(fs.readFileSync(file)).plugins[0].options});
    const historyOnly = request();
    assert.equal(onProvider(historyOnly, context()), undefined);
    assert.equal(historyOnly.tools[0].parameters.type, undefined);

    const current = store.get().options;
    store.save({base: current, draft: globalThis.HistorySettings.change(current, 'strict-deepseek', 'deepSeekObjectRoot', true)});
    const optedIn = request();
    assert.equal(onProvider(optedIn, context()), optedIn);
    assert.equal(optedIn.tools[0].parameters.type, 'object');
  } finally { fs.rmSync(root, {recursive: true}); }
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
