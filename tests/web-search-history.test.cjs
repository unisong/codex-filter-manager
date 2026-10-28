'use strict';
const {test, before} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {filterResponsesRequest, makeProxy} = require('../src/proxy.cjs');
let onRequest;
before(async () => {
  const {combineMiddleware} = await import('../magpie-workbench/server/middleware.mjs');
  ({onRequest} = await import('data:text/javascript;base64,' + Buffer.from(combineMiddleware()).toString('base64')));
});

// Shapes match a Codex text-compaction history; all data here is synthetic.
const body = {model: 'demo/gpt-6.1-sol', reasoning: {effort: 'xhigh'},
  instructions: 'Summarize this conversation for the next context window.',
  include: ['reasoning.encrypted_content'], input: [
    {type: 'reasoning', id: 'rs_foreign', encrypted_content: 'FOREIGN_CIPHERTEXT', summary: []},
    {type: 'web_search_call', id: 'ws_foreign', status: 'completed',
      action: {type: 'search', query: 'official option rules', queries: ['official option rules', 'current deadlines'],
        sources: [{type: 'url', url: 'https://example.invalid/rules'}]},
      internal_chat_message_metadata_passthrough: {turn_id: 'PRIVATE_TURN'}},
    {type: 'message', role: 'assistant', content: 'Saved finding: deadline is 15:00. https://example.invalid/rules'},
    {type: 'function_call', id: 'fc_old', call_id: 'pair_keep', name: 'read_file', arguments: '{"id":"BUSINESS_ID"}'},
    {type: 'function_call_output', id: 'out_old', call_id: 'pair_keep', output: 'FILE_TEXT_KEEP'},
    {role: 'user', content: 'Produce a text summary; do not perform any new searches.'}
  ]};
const options = {providers: {'magpie:demo': {historyFilter: true, preserveEncryptedInclude: true}}};
function filteredByPlugin(request, extra = {}) {
  let rejection;
  const result = onRequest(request, {protocol: 'responses', path: '/v1/responses', options,
    ...extra, reject: (status, message) => { rejection = {status, message}; }});
  return {result, rejection};
}

test('web search history becomes a lossless text record without server IDs or required reasoning dependencies', () => {
  const before = JSON.stringify(body);
  const cleaned = filterResponsesRequest(body, {preserveEncryptedInclude: true});
  assert.equal(cleaned.removed, 1);
  assert.equal(cleaned.removedItemIds, 3);
  const record = cleaned.body.input[0];
  assert.equal(record.type, 'message'); assert.equal(record.role, 'assistant');
  assert.match(record.content, /Historical web search activity/);
  assert.deepEqual(JSON.parse(record.content.slice(record.content.indexOf('\n') + 1)), {
    status: 'completed', action: body.input[1].action
  });
  assert.doesNotMatch(record.content, /ws_foreign|rs_foreign|FOREIGN_CIPHERTEXT|PRIVATE_TURN/);
  assert.deepEqual(cleaned.body.input.slice(1), [body.input[2],
    {...body.input[3], id: undefined}, {...body.input[4], id: undefined}, body.input[5]]
    .map(item => { const copy = {...item}; delete copy.id; return copy; }));
  assert.equal(cleaned.body.instructions, body.instructions);
  assert.deepEqual(cleaned.body.reasoning, body.reasoning);
  assert.deepEqual(cleaned.body.include, body.include);
  assert.equal(cleaned.body.model, body.model);
  assert.deepEqual(filterResponsesRequest(cleaned.body, {preserveEncryptedInclude: true}).body, cleaned.body);
  assert.equal(JSON.stringify(body), before);
  assert.deepEqual(filteredByPlugin(body).result, cleaned.body);
});

test('open/find actions, source data and incomplete status stay recorded without becoming fresh tools', () => {
  for (const action of [
    {type: 'open_page', url: 'https://example.invalid/doc', sources: [{id: 'BUSINESS_ID', title: 'Document'}]},
    {type: 'find_in_page', url: 'https://example.invalid/doc', pattern: 'deadline'}
  ]) {
    const input = {type: 'web_search_call', status: 'in_progress', action};
    const result = filterResponsesRequest({input: [input]}).body.input[0];
    assert.deepEqual(JSON.parse(result.content.split('\n').slice(1).join('\n')), {status: 'in_progress', action});
    assert.equal(result.type, 'message');
  }
  assert.equal(filteredByPlugin(body, {options: {}}).result, undefined);
  assert.equal(filteredByPlugin({...body, model: 'other/gpt-6.1-sol'}).result, undefined);
  assert.equal(filteredByPlugin(body, {protocol: 'chat-completions'}).result, undefined);
  assert.equal(filteredByPlugin(body, {path: '/v1/responses/compact'}).rejection.status, 409);
  assert.throws(() => filterResponsesRequest({input: [{type: 'compaction', encrypted_content: 'sealed'}]}),
    {code: 'encrypted_context_not_portable'});
});

test('plain-text summarization survives both missing-reasoning and Azure-resource mock failures through plugin and CCS proxy', async t => {
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); observed.push(input);
    const native = input.input.find(item => item.type === 'web_search_call');
    const missing = native && !input.input.some(item => item.type === 'reasoning');
    const foreign = input.input.some(item => item.id || item.encrypted_content);
    res.writeHead(missing || foreign ? 400 : 200, {'content-type': 'application/json'});
    res.end(JSON.stringify(missing ? {error: 'web_search_call was provided without its required reasoning item'}
      : foreign ? {error: 'The requested item was created under a different Azure OpenAI resource.'}
      : {object: 'response', status: 'completed', output: [{type: 'message', role: 'assistant', content: [
        {type: 'output_text', text: 'SUMMARY_KEEPS_SAVED_FINDING_AND_FILE_TEXT'}]}]}));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => {upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve));});
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  const send = (url, request) => fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(request)});
  assert.equal((await send(origin, body)).status, 400);
  assert.equal((await send(origin, {...body, input: body.input.filter(item => item.type !== 'reasoning')})).status, 400);
  assert.equal((await send(origin, filteredByPlugin(body).result)).status, 200);
  const proxy = makeProxy({getUpstream: () => origin, getFilterPolicy: () => ({filter: true, preserveEncryptedInclude: true})});
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {proxy.closeAllConnections(); return new Promise(resolve => proxy.close(resolve));});
  const response = await send('http://127.0.0.1:' + proxy.address().port + '/v1/responses', body);
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), /SUMMARY_KEEPS/);
  assert.deepEqual(observed.at(-1), filteredByPlugin(body).result);
});
