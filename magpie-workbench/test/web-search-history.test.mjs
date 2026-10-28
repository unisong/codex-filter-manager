import assert from 'node:assert/strict';
import {test} from 'node:test';
import {onRequest as original} from '../history/codex-history.middleware.js';
import {combineMiddleware} from '../server/middleware.mjs';
import {gateCode} from '../server/engine.mjs';

const options = {providers: {'magpie:demo': {historyFilter: true, preserveEncryptedInclude: true}}, aliases: {old: 'demo'}};
const body = {model: 'demo/gpt-6.1-sol', include: ['reasoning.encrypted_content'], reasoning: {effort: 'xhigh'},
  instructions: 'Summarize the conversation into a plain-text handoff.', input: [
    {type: 'reasoning', id: 'rs_foreign', summary: [], encrypted_content: 'CIPHER'},
    {type: 'web_search_call', id: 'ws_foreign', status: 'completed',
      action: {type: 'search', query: 'official rules', queries: ['official rules', 'current deadlines']},
      internal_chat_message_metadata_passthrough: {turn_id: 'PRIVATE_TURN'}},
    {type: 'message', role: 'assistant', content: 'Saved source finding: https://example.invalid/rules'},
    {type: 'function_call', id: 'fc_foreign', name: 'read_file', call_id: 'keep_pair', arguments: '{"id":"BUSINESS_ID"}'},
    {type: 'function_call_output', id: 'out_foreign', call_id: 'keep_pair', output: 'KEEP_TEXT'},
    {role: 'user', content: 'Produce the summary without new searches.'}
  ]};
const load = async (code = combineMiddleware()) => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
function invoke(hook, request, extra = {}) {
  let rejection;
  const result = hook(request, {protocol: 'responses', path: '/v1/responses', options,
    ...extra, reject: (status, message) => { rejection = {status, message}; }});
  return {result, rejection};
}

test('text compaction no longer replays native search items after removing their encrypted reasoning', async () => {
  const baseline = invoke(original, body).result;
  assert.equal(baseline.input[0].type, 'web_search_call');
  assert.equal(baseline.input[0].id, 'ws_foreign');
  assert.ok(baseline.input.every(item => item.type !== 'reasoning'));
  const before = JSON.stringify(body);
  const {onRequest} = await load();
  const {result, rejection} = invoke(onRequest, body);
  assert.equal(rejection, undefined);
  assert.ok(result.input.every(item => !['reasoning', 'web_search_call'].includes(item.type)));
  const record = result.input[0];
  assert.equal(record.type, 'message'); assert.equal(record.role, 'assistant');
  assert.deepEqual(JSON.parse(record.content.slice(record.content.indexOf('\n') + 1)), {
    status: 'completed', action: body.input[1].action
  });
  assert.doesNotMatch(record.content, /ws_foreign|rs_foreign|CIPHER|PRIVATE_TURN/);
  assert.deepEqual(result.input.slice(1), baseline.input.slice(1));
  assert.equal(result.instructions, body.instructions);
  assert.equal(result.model, body.model);
  assert.deepEqual(result.reasoning, body.reasoning);
  assert.deepEqual(result.include, body.include);
  assert.equal(JSON.stringify(body), before);
  assert.deepEqual(invoke(onRequest, result).result, result);
});

test('web search adaptation keeps scope, pause enforcement and encrypted-compaction rejection', async () => {
  const {onRequest} = await load(combineMiddleware(gateCode([{model: body.model, mode: 'protect', paused: true}], 'fixture-secret')));
  assert.equal(invoke(onRequest, body).rejection.status, 409);
  const probe = invoke(onRequest, {...body, model: 'workbench-probe/fixture-secret/' + body.model});
  assert.equal(probe.rejection, undefined);
  assert.equal(probe.result.model, body.model);
  assert.equal(probe.result.input[0].type, 'message');
  const combined = (await load()).onRequest;
  assert.equal(invoke(combined, body, {options: {}}).result, undefined);
  assert.equal(invoke(combined, {...body, model: 'other/gpt-6.1-sol'}).result, undefined);
  assert.equal(invoke(combined, body, {protocol: 'chat-completions'}).result, undefined);
  assert.equal(invoke(combined, body, {path: '/v1/responses/compact'}).rejection.status, 409);
  assert.equal(invoke(combined, {...body, input: [{type: 'compaction', encrypted_content: 'sealed'}]}).rejection.status, 400);
  assert.equal(invoke(combined, {...body, model: 'old/gpt-6.1-sol'}).result.input[0].type, 'message');
  const withoutDetector = (await load(combineMiddleware('export function onRequest(){throw Error("offline")}'))).onRequest;
  assert.equal(invoke(withoutDetector, body).result.input[0].type, 'message');
});
