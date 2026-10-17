'use strict';
const {test, before} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {filterResponsesRequest} = require('../src/proxy.cjs');
const {makeProxy} = require('../src/proxy.cjs');

let onRequest;
before(async () => {
  const {combineMiddleware} = await import('../magpie-workbench/server/middleware.mjs');
  ({onRequest} = await import('data:text/javascript;base64,' + Buffer.from(combineMiddleware()).toString('base64')));
});

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
