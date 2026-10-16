'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {onRequest} = require('./magpie-plugin/history.middleware.js');
const {filterResponsesRequest} = require('./proxy.cjs');
const {createMagpiePluginStore} = require('./magpie-plugin-store.cjs');
const {createManagement} = require('./management.cjs');
const {createMagpieAdapter} = require('./magpie.cjs');
const {makeProxy} = require('./proxy.cjs');

const rule = {historyFilter: true, preserveEncryptedInclude: true, stripResponsesLiteHeader: false};
function context(overrides = {}) {
  return {protocol: 'responses', path: '/v1/responses', options: {providers: {'magpie:one': rule}},
    reject(status, message) { this.rejected = {status, message}; }, ...overrides};
}
const body = {
  model: 'one/gpt-6.1-sol', stream: true, include: ['reasoning.encrypted_content'], reasoning: {effort: 'high'},
  input: [
    {type: 'reasoning', id: 'rs_azure_A', summary: [], encrypted_content: 'foreign'},
    {type: 'message', id: 'msg_azure_A', role: 'user', content: 'keep text'},
    {type: 'tool_search_call', id: 'tsc_azure_A', call_id: 'search_keep', execution: 'client', arguments: {query: 'tools'}, status: 'completed'},
    {type: 'tool_search_output', id: 'tso_azure_A', call_id: 'search_keep', execution: 'client', tools: [{type: 'function', name: 'lookup', parameters: {type: 'object'}}]},
    {type: 'additional_tools', id: 'additional_azure_A', role: 'developer', tools: []},
    {type: 'function_call', id: 'fc_azure_A', call_id: 'call_keep', name: 'lookup', arguments: '{"id":"BUSINESS_ID"}'},
    {type: 'function_call_output', id: 'out_azure_A', call_id: 'call_keep', output: 'keep result'},
    {type: 'message', role: 'user', content: [{type: 'input_file', file_id: 'file_keep'}]}
  ]
};

test('shared proxy/plugin filter removes cross-resource search IDs without losing schemas, call pairs or original data', () => {
  const original = JSON.stringify(body), ctx = context();
  const cleaned = onRequest(body, ctx);
  assert.equal(ctx.rejected, undefined);
  assert.equal(cleaned.model, body.model); assert.deepEqual(cleaned.reasoning, body.reasoning);
  assert.deepEqual(cleaned.include, body.include);
  assert.equal(cleaned.store, false); assert.equal(cleaned.input.length, 7);
  assert.equal(cleaned.input[1].call_id, 'search_keep'); assert.equal(cleaned.input[2].call_id, 'search_keep');
  assert.deepEqual(cleaned.input[1].arguments, body.input[2].arguments);
  assert.deepEqual(cleaned.input[2].tools, body.input[3].tools);
  assert.deepEqual(cleaned.input[3].tools, []);
  assert.equal(cleaned.input[4].call_id, cleaned.input[5].call_id);
  assert.equal(cleaned.input[4].arguments, body.input[5].arguments);
  assert.equal(cleaned.input[6].content[0].file_id, 'file_keep');
  assert.ok(cleaned.input.every(item => !item.id));
  assert.equal(JSON.stringify(body), original);
  assert.deepEqual(cleaned, filterResponsesRequest(body, {preserveEncryptedInclude: true}).body);
  assert.deepEqual(onRequest(cleaned, context()), cleaned);
});

test('middleware defaults off, scopes by actual provider prefix, respects off options and handles old aliases', () => {
  assert.equal(onRequest(body, context({options: {}})), undefined);
  assert.equal(onRequest({...body, model: 'two/gpt-6.1-sol'}, context()), undefined);
  assert.equal(onRequest({...body, model: 'one'}, context()), undefined);
  assert.equal(onRequest(body, context({protocol: 'anthropic'})), undefined);
  assert.equal(onRequest(body, context({options: {providers: {'magpie:one': {...rule, historyFilter: false}}}})), undefined);
  const ctx = context(); ctx.options.aliases = {'old-one': 'one'};
  assert.equal(onRequest({...body, model: 'old-one/gpt-6.1-sol'}, ctx).input.length, 7);
});

test('unsafe historical references explicitly reject through ctx instead of throwing or silently discarding history', () => {
  for (const unsafe of [{previous_response_id: 'resp_A'}, {conversation: 'conv_A'}, {input: [{type: 'item_reference', id: 'item_A'}]},
    {input: [{type: 'compaction', encrypted_content: 'sealed'}]}, {context_management: [{type: 'compaction'}]}]) {
    const ctx = context(); assert.doesNotThrow(() => onRequest({...body, ...unsafe}, ctx));
    assert.ok(ctx.rejected); assert.match(ctx.rejected.message, /Codex history filter:/);
  }
  const compact = context({path: '/v1/responses/compact'});
  onRequest(body, compact); assert.equal(compact.rejected.status, 409);
});

test('Azure mock rejects old IDs and accepts the plugin-filtered request from a direct gateway client', async t => {
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const input = JSON.parse(text).input;
    const foreign = input.some(it => it.id?.includes('azure_A') || it.encrypted_content);
    res.writeHead(foreign ? 400 : 200, {'content-type': 'application/json'});
    res.end(JSON.stringify(foreign ? {error: 'The requested item was created under a different Azure OpenAI resource.'} : {ok: true}));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => {upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve));});
  const url = 'http://127.0.0.1:' + upstream.address().port;
  assert.equal((await fetch(url, {method: 'POST', body: JSON.stringify(body)})).status, 400);
  assert.equal((await fetch(url, {method: 'POST', body: JSON.stringify(onRequest(body, context()))})).status, 200);
  // The standalone proxy uses the same fixed algorithm.
  const proxy = makeProxy({getUpstream: () => url, getFilterPolicy: () => ({filter: true})});
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {proxy.closeAllConnections(); return new Promise(resolve => proxy.close(resolve));});
  assert.equal((await fetch('http://127.0.0.1:' + proxy.address().port + '/v1/responses', {method: 'POST', body: JSON.stringify(body)})).status, 200);
});

test('plugin store and management share options, preserve other plugins and never enable unsupported auto protection', t => {
  const root = fs.realpathSync(process.env.PI_SCRATCH_DIR), directory = fs.mkdtempSync(path.join(root, 'plugin-'));
  t.after(() => {assert.equal(path.dirname(fs.realpathSync(directory)), root); fs.rmSync(directory, {recursive: true, force: true});});
  const configPath = path.join(directory, 'config.toml'), filename = path.join(directory, 'plugins.json');
  fs.writeFileSync(configPath, 'model="one/gpt-6.1-sol"\nmodel_provider="magpie"\n[model_providers.magpie]\nbase_url="http://127.0.0.1:3425/v1"');
  fs.writeFileSync(path.join(directory, 'providers.json'), JSON.stringify({providers: [{id: 'one', name: 'One', responses: 'https://one.invalid/v1', was: ['old-one']}]}));
  const untouched = {spec: 'another-plugin', off: true, options: {retain: 'LOCAL_SECRET'}};
  fs.writeFileSync(filename, JSON.stringify({plugins: [untouched], config: {preserved: true}}));
  const store = createMagpiePluginStore({directory}); store.install({'magpie:one': rule, 'ccs-old': rule});
  store.install(); assert.equal(store.rules().data.providers['magpie:one'].historyFilter, true);
  assert.equal(store.rules().data.providers['ccs-old'], undefined);
  const adapter = createMagpieAdapter({directory, configPath, getUpstream: () => 'http://127.0.0.1:3425'});
  const manager = createManagement({runtime: directory, adapter, pluginStore: store, guard: {snapshot: () => ({providers: {}})}});
  const state = manager.state(); assert.equal(state.integration.automaticProtection, false);
  manager.handle('PUT', '/providers/magpie:one/rule', {revision: state.revision, rule: {...rule, historyFilter: false}});
  assert.equal(store.rules().data.providers['magpie:one'].historyFilter, false);
  assert.throws(() => manager.handle('PUT', '/providers/magpie:one/rule', {revision: state.revision, rule}), {code: 'rules_changed'});
  assert.throws(() => manager.handle('PUT', '/guard/providers/magpie:one', {enabled: true}), {code: 'plugin_guard_unsupported'});
  assert.throws(() => manager.handle('PUT', '/providers/magpie:one/rule', {revision: manager.state().revision,
    rule: {...rule, stripResponsesLiteHeader: true}}), {code: 'plugin_header_unsupported'});
  assert.doesNotMatch(JSON.stringify(manager.state()), /LOCAL_SECRET/);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).plugins[0], untouched);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).config, {preserved: true});
  const before = store.rules();
  const other = JSON.parse(fs.readFileSync(filename, 'utf8')); other.plugins[0].off = false; fs.writeFileSync(filename, JSON.stringify(other));
  assert.throws(() => store.update(before.data.providers, before.revision), /changed/);
  other.plugins.find(p => p.spec === path.resolve(__dirname, 'magpie-plugin')).off = true;
  fs.writeFileSync(filename, JSON.stringify(other));
  assert.equal(manager.state().integration.enabled, false);
  assert.equal(manager.state().currentPolicy.filter, false);
  assert.equal(manager.policy(body).filter, false);
});
