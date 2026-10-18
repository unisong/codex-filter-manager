'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const {once} = require('node:events');
const {spawn, spawnSync} = require('node:child_process');
const {makeProxy, filterResponsesRequest, localOrigin, decodeBody, ADMIN, FILTER_VERSION} = require('../src/proxy.cjs');
const {ConfigRouter, providerBase, readFilterPolicy} = require('../src/config.cjs');
const {start, stop, status, parseArgs, ownsProcess} = require('../filter.cjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
function call(origin, route, {body, headers = {}, method = 'POST'} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(origin + route, {method, headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
    });
    request.setTimeout(5000, () => request.destroy(new Error('test request timeout')));
    request.on('error', reject);
    request.end(body);
  });
}
function fixture(t) {
  const root = process.env.PI_SCRATCH_DIR;
  assert.ok(root, 'PI_SCRATCH_DIR is required; never create test files in the workspace');
  fs.mkdirSync(root, {recursive: true});
  const directory = fs.mkdtempSync(path.join(root, 'test-'));
  t.after(() => {
    // Only remove this test's scratch directory.
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(root));
    assert.match(path.basename(directory), /^test-/);
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return directory;
}
const sample = {
  model: 'mock-model', store: true, stream: true, reasoning: {effort: 'xhigh', summary: 'auto'},
  include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
  input: [
    {role: 'user', content: [{type: 'input_text', text: '你好'}, {type: 'input_image', image_url: 'data:image/png;base64,AAAA'}]},
    {type: 'reasoning', id: 'rs_old', encrypted_content: 'foreign-account-ciphertext', summary: []},
    {type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"x":1}'},
    {type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'result'},
    {type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_2', name: 'exec', input: 'a'},
    {type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_2', output: 'ok'},
    {type: 'message', id: 'msg_old', role: 'assistant', phase: 'final_answer',
      content: [{type: 'output_text', text: 'done', annotations: [{type: 'file_citation', file_id: 'file_keep', index: 0, filename: 'evidence.txt'}]}]}
  ]
};

test('public CLI works outside the install folder and keeps the existing runtime location', t => {
  const directory = fixture(t);
  const project = path.resolve(__dirname, '..');
  const result = spawnSync(process.execPath, [path.join(project, 'filter.cjs'), 'help'], {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node filter\.cjs start\|stop\|status\|diagnose\|serve/);
  assert.equal(parseArgs(['help']).runtime, path.join(project, '.runtime'));
  assert.equal(parseArgs(['help', '--runtime', directory]).runtime, directory);
});

test('removes historical reasoning while preserving tools, images, effort, and original input', () => {
  const snapshot = JSON.stringify(sample);
  const result = filterResponsesRequest(sample);
  assert.equal(result.removed, 1);
  assert.equal(result.removedItemIds, 5);
  assert.equal(result.body.store, false);
  assert.deepEqual(result.body.include, ['message.output_text.logprobs']);
  assert.deepEqual(result.body.input, [
    sample.input[0],
    {type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"x":1}'},
    {type: 'function_call_output', call_id: 'call_1', output: 'result'},
    {type: 'custom_tool_call', call_id: 'call_2', name: 'exec', input: 'a'},
    {type: 'custom_tool_call_output', call_id: 'call_2', output: 'ok'},
    {type: 'message', role: 'assistant', phase: 'final_answer', content: sample.input[6].content}
  ]);
  assert.deepEqual(result.body.reasoning, sample.reasoning);
  assert.equal(JSON.stringify(sample), snapshot);
  assert.deepEqual(filterResponsesRequest({input: 'hello'}).body, {input: 'hello', store: false});
});

test('strips only optional history item IDs, keeping call IDs and resource references', () => {
  const input = [
    {id: 'msg_shorthand', role: 'user', content: [{type: 'input_file', file_id: 'file_keep'}]},
    {type: 'function_call', id: 'fc_outer', call_id: 'call_keep', name: 'lookup', arguments: '{"id":"business_1"}'},
    {type: 'function_call_output', id: 'fco_outer', call_id: 'call_keep', output: [{type: 'input_text', text: '{"id":"business_2"}'}]},
    {type: 'file_search_call', id: 'fs_required', status: 'completed', queries: ['test'], results: []},
    {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'ok'}]}
  ];
  const result = filterResponsesRequest({input});
  assert.equal(result.removedItemIds, 3);
  assert.equal(result.body.input[0].id, undefined);
  assert.equal(result.body.input[0].content[0].file_id, 'file_keep');
  assert.equal(result.body.input[1].call_id, result.body.input[2].call_id);
  assert.equal(result.body.input[1].arguments, input[1].arguments);
  assert.deepEqual(result.body.input[2].output, input[2].output);
  assert.deepEqual(result.body.input.slice(3), input.slice(3));
  assert.equal(input[0].id, 'msg_shorthand');
  assert.equal(filterResponsesRequest(result.body).removedItemIds, 0);
});

test('AnyRouter mode keeps the encrypted include while still removing reasoning items and portable IDs', () => {
  const snapshot = JSON.stringify(sample);
  const result = filterResponsesRequest(sample, {preserveEncryptedInclude: true});
  // include is a per-response output option, not replayed history: keeping it must not stop history cleanup.
  assert.deepEqual(result.body.include, ['reasoning.encrypted_content', 'message.output_text.logprobs']);
  assert.notEqual(result.body.include, sample.include);
  assert.equal(result.removed, 1);
  assert.equal(result.removedItemIds, 5);
  assert.equal(result.body.store, false);
  assert.deepEqual(result.body.input, [
    sample.input[0],
    {type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"x":1}'},
    {type: 'function_call_output', call_id: 'call_1', output: 'result'},
    {type: 'custom_tool_call', call_id: 'call_2', name: 'exec', input: 'a'},
    {type: 'custom_tool_call_output', call_id: 'call_2', output: 'ok'},
    {type: 'message', role: 'assistant', phase: 'final_answer', content: sample.input[6].content}
  ]);
  assert.equal(result.body.input[1].call_id, 'call_1');
  assert.equal(result.body.input[3].call_id, 'call_2');
  assert.deepEqual(result.body.reasoning, sample.reasoning);
  assert.equal(JSON.stringify(sample), snapshot);
  assert.deepEqual(sample.include, ['reasoning.encrypted_content', 'message.output_text.logprobs']);
  const again = filterResponsesRequest(result.body, {preserveEncryptedInclude: true});
  assert.equal(again.removed, 0);
  assert.equal(again.removedItemIds, 0);
  assert.deepEqual(again.body, result.body);
});

test('removes nested encrypted content from agent and tool messages without changing readable content', () => {
  const input = [
    {type: 'agent_message', id: 'amsg_old', content: [
      {type: 'input_text', text: '保留这段文字'},
      {type: 'encrypted_content', encrypted_content: 'agent-ciphertext'}
    ]},
    {type: 'custom_tool_call', id: 'ctc_old', call_id: 'call_keep', name: 'exec', input: {
      content: [
        {type: 'input_text', text: '工具输入'},
        {type: 'encrypted_content', encrypted_content: 'tool-ciphertext'}
      ],
      resource_id: 'resource_keep'
    }},
    {type: 'custom_tool_call_output', id: 'ctco_old', call_id: 'call_keep', output: [
      {type: 'output_text', text: '工具输出'},
      {type: 'encrypted_content', encrypted_content: 'output-ciphertext'}
    ]}
  ];
  const body = {input};
  const snapshot = JSON.stringify(body);
  const result = filterResponsesRequest(body);
  assert.equal(result.removed, 0);
  assert.equal(result.removedItemIds, 3);
  assert.equal(result.removedEncryptedContentItems, 3);
  assert.deepEqual(result.body.input, [
    {type: 'agent_message', content: [{type: 'input_text', text: '保留这段文字'}]},
    {type: 'custom_tool_call', call_id: 'call_keep', name: 'exec', input: {
      content: [{type: 'input_text', text: '工具输入'}], resource_id: 'resource_keep'
    }},
    {type: 'custom_tool_call_output', call_id: 'call_keep', output: [{type: 'output_text', text: '工具输出'}]}
  ]);
  assert.equal(JSON.stringify(body), snapshot);
});

test('explicit provider filter removes nested encrypted content before forwarding', async t => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"ok":true}');
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin,
    getFilterPolicy: () => ({filter: true, mode: 'filtering', provider: 'provider.example'})});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const body = {model: 'mock-model', stream: true, input: [
    {type: 'agent_message', id: 'amsg_old', content: [
      {type: 'input_text', text: 'Provider history'},
      {type: 'encrypted_content', encrypted_content: 'foreign-ciphertext'}
    ]},
    {type: 'custom_tool_call', id: 'ctc_old', call_id: 'call_keep', name: 'exec', input: {
      content: [{type: 'input_text', text: 'keep'}, {type: 'encrypted_content', encrypted_content: 'tool-ciphertext'}]
    }}
  ]};
  const response = await call(origin, '/responses', {body: JSON.stringify(body)});
  assert.equal(response.status, 200);
  assert.deepEqual(received.input, [
    {type: 'agent_message', content: [{type: 'input_text', text: 'Provider history'}]},
    {type: 'custom_tool_call', call_id: 'call_keep', name: 'exec', input: {
      content: [{type: 'input_text', text: 'keep'}]
    }}
  ]);
});

test('preserved include is copied verbatim; a missing or empty include is never invented', () => {
  const preserved = ['reasoning.encrypted_content', 'reasoning.encrypted_content', 'message.output_text.logprobs'];
  const body = {include: preserved, input: []};
  const snapshot = JSON.stringify(body);
  const result = filterResponsesRequest(body, {preserveEncryptedInclude: true});
  assert.deepEqual(result.body, {include: preserved, input: [], store: false});
  assert.notEqual(result.body.include, preserved);
  assert.equal(JSON.stringify(body), snapshot);
  for (const request of [{input: []}, {include: [], input: []}]) {
    const kept = filterResponsesRequest(request, {preserveEncryptedInclude: true}).body;
    assert.deepEqual(kept, {...request, store: false});
    assert.equal(Object.hasOwn(kept, 'include'), Object.hasOwn(request, 'include'));
  }
  // When enabled without preservation, filtering removes the encrypted include.
  assert.deepEqual(filterResponsesRequest({include: preserved}, {}).body.include, ['message.output_text.logprobs']);
  assert.deepEqual(filterResponsesRequest({include: preserved}).body.include, ['message.output_text.logprobs']);
});

test('upstream accepts replayed history with no resource-bound item IDs and intact tool pairs', async t => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks));
    const foreign = received.input.some(item => item.id !== undefined || item.type === 'reasoning');
    const tools = received.input.filter(item => item.call_id);
    const paired = tools.length === 4 && tools[0].call_id === tools[1].call_id && tools[2].call_id === tools[3].call_id;
    res.writeHead(foreign || !paired ? 400 : 200, {'content-type': 'application/json'});
    res.end(JSON.stringify(foreign ? {error: 'The requested item was created under a different resource.'} : {paired}));
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => ({filter: true})});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const body = JSON.stringify(sample);
  assert.equal((await call(upstreamOrigin, '/responses', {body})).status, 400);
  const result = await call(origin, '/responses', {body});
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).paired, true);
  assert.equal(received.input.at(-1).content[0].annotations[0].file_id, 'file_keep');
});
test('fails explicitly on cross-account references and compaction', () => {
  for (const body of [
    {previous_response_id: 'resp_old'}, {conversation: {id: 'conv_old'}},
    {input: [{type: 'compaction', encrypted_content: 'x'}]}, {input: [{type: 'item_reference', id: 'old'}]},
    {input: [{type: 'new_opaque_type', encrypted_content: 'x'}]}, {context_management: [{type: 'compaction'}]}
  ]) assert.throws(() => filterResponsesRequest(body), /text summary/);
  for (const body of [null, [], {include: 'x'}, {input: {type: 'message'}}]) {
    assert.throws(() => filterResponsesRequest(body));
  }
  assert.throws(() => localOrigin('https://example.com'));
  assert.throws(() => localOrigin('http://127.0.0.1:15721/v1'));
});
test('HTTP filtering handles all compressed forms and preserves authorization, path and errors', {timeout: 15000}, async t => {
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured.push({path: req.url, headers: req.headers, body: Buffer.concat(chunks)});
    res.writeHead(req.url.includes('quota') ? 429 : 200, {'content-type': 'application/json', 'x-test': 'unchanged'});
    res.end('{"from":"upstream"}');
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => ({filter: true})});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const raw = Buffer.from(JSON.stringify(sample));
  for (const [encoding, body] of [
    ['identity', raw], ['gzip', zlib.gzipSync(raw)], ['deflate', zlib.deflateSync(raw)],
    ['br', zlib.brotliCompressSync(raw)], ['zstd', zlib.zstdCompressSync(raw)]
  ]) {
    const result = await call(origin, '/v1/responses?mode=quota', {body, headers: {
      'content-encoding': encoding, 'content-length': String(body.length), authorization: 'Bearer mock-secret',
      'x-session-id': 'session-1', connection: 'x-hop', 'x-hop': 'remove'
    }});
    assert.equal(result.status, 429);
    assert.equal(result.headers['x-test'], 'unchanged');
    const received = captured.at(-1);
    assert.equal(received.path, '/v1/responses?mode=quota');
    assert.equal(received.headers.authorization, 'Bearer mock-secret');
    assert.equal(received.headers['x-session-id'], 'session-1');
    assert.equal(received.headers['x-hop'], undefined);
    assert.equal(received.headers['content-encoding'], undefined);
    assert.equal(Number(received.headers['content-length']), received.body.length);
    assert.deepEqual(JSON.parse(received.body), filterResponsesRequest(sample).body);
  }
  await call(origin, '/responses/', {body: raw});
  await call(origin, '/api/codex/v1/responses', {body: raw});
  assert.deepEqual(JSON.parse(captured.at(-1).body), filterResponsesRequest(sample).body);
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.stats.filteredRequests, 7);
  assert.equal(health.stats.removedReasoningItems, 7);
  assert.equal(health.filterVersion, FILTER_VERSION);
  assert.equal(health.stats.removedItemIds, 35);
  assert.equal(health.stats.upstreamHttpErrors, 5);
  assert.equal(health.stats.lastUpstreamStatus, 200);
  assert.ok(Number.isFinite(Date.parse(health.stats.lastFilteredAt)));
  const previousCount = captured.length;
  for (const [route, body, expected] of [
    ['/v1/responses', '{', 400],
    ['/v1/responses/compact', '{}', 409],
    ['/responses', '{"previous_response_id":"x"}', 400],
    ['/v1/responses', '{"input":[{"type":"compaction"}]}', 400]
  ]) assert.equal((await call(origin, route, {body})).status, expected);
  assert.equal((await call(origin, '/responses', {body: raw, headers: {origin: 'http://example.com'}})).status, 403);
  assert.equal(captured.length, previousCount);
  assert.equal((await call(origin, ADMIN + '/stop', {body: '{}'})).status, 403);
  await call(origin, '/models', {method: 'GET'});
  assert.equal(captured.at(-1).path, '/models');
});
test('queued 429s are replayed until the upstream accepts the request', {timeout: 15000}, async t => {
  const queued = 'All concurrency slots are busy. You are number 7 of 42 in the queue, please retry in about 5 seconds';
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamCalls++;
    if (upstreamCalls < 3) {
      res.writeHead(429, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: {code: 'concurrency_queued', message: queued}}));
      return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"ok":true}');
  });
  const upstreamOrigin = await listen(upstream);
  const events = [];
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => ({filter: true}),
    retry429: {maxAttempts: 5, baseDelayMs: 20, maxDelayMs: 80, budgetMs: 5000},
    log: (event, data) => events.push({event, data})});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const result = await call(origin, '/responses', {body: JSON.stringify(sample)});
  assert.equal(result.status, 200);
  assert.equal(upstreamCalls, 3);
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.stats.retries429, 2);
  assert.equal(health.stats.retry429Exhausted, 0);
  assert.ok(events.filter(x => x.event === 'retry-429').length === 2);
  assert.ok(events.every(x => !JSON.stringify(x).includes('mock-secret')));
});
test('permanent quota 429 passes through immediately without replay', {timeout: 15000}, async t => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    upstreamCalls++;
    res.writeHead(429, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: {code: 'insufficient_quota', message: 'credit balance exhausted'}}));
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => ({filter: true}),
    retry429: {maxAttempts: 10, baseDelayMs: 20, maxDelayMs: 80, budgetMs: 5000}});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const result = await call(origin, '/responses', {body: JSON.stringify(sample)});
  assert.equal(result.status, 429);
  assert.equal(upstreamCalls, 1);
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.stats.retries429, 0);
  assert.equal(health.stats.retry429Permanent, 1);
});
test('429 replay budget is respected and the final error is forwarded', {timeout: 15000}, async t => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    upstreamCalls++;
    res.writeHead(429, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: {code: 'concurrency_queued', message: 'busy'}}));
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => ({filter: true}),
    retry429: {maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 40, budgetMs: 5000}});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const result = await call(origin, '/responses', {body: JSON.stringify(sample)});
  assert.equal(result.status, 429);
  assert.equal(upstreamCalls, 3);
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.stats.retries429, 2);
  assert.equal(health.stats.retry429Exhausted, 1);
});
test('SSE first chunk arrives before upstream ends; client cancellation closes upstream', {timeout: 10000}, async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  let disconnected;
  const canceled = new Promise(resolve => { disconnected = resolve; });
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('event: response.output_text.delta\ndata: {"delta":"first"}\n\n');
    if (req.url.includes('cancel')) res.on('close', disconnected);
    else { await gate; res.end('event: response.completed\ndata: {"done":true}\n\n'); }
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin});
  const origin = await listen(proxy);
  t.after(async () => { finish(); await close(proxy); await close(upstream); });
  await new Promise((resolve, reject) => {
    const req = http.request(origin + '/responses', {method: 'POST'}, res => {
      let received = '';
      res.on('data', chunk => {
        received += chunk;
        if (received.includes('"first"')) finish();
      });
      res.on('end', () => {
        try { assert.match(received, /response.completed/); resolve(); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(sample));
  });
  await new Promise((resolve, reject) => {
    const req = http.request(origin + '/responses?cancel=1', {method: 'POST'}, res => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.on('error', reject);
    req.end(JSON.stringify(sample));
  });
  await canceled;
});
test('size limit, upstream offline, proxy loops and WebSocket fail explicitly', {timeout: 10000}, async t => {
  const unused = http.createServer();
  const unavailableOrigin = await listen(unused);
  await close(unused);
  const proxy = makeProxy({getUpstream: () => unavailableOrigin, limit: 32, getFilterPolicy: () => ({filter: true})});
  const origin = await listen(proxy);
  t.after(() => close(proxy));
  assert.equal((await call(origin, '/responses', {body: 'x'.repeat(100)})).status, 413);
  assert.equal((await call(origin, '/responses', {body: '{}'})).status, 502);
  const expanded = zlib.gzipSync(Buffer.from('x'.repeat(1000)));
  assert.equal((await call(origin, '/responses', {body: expanded, headers: {'content-encoding': 'gzip'}})).status, 413);
  const loop = makeProxy({getUpstream: () => loopOrigin});
  const loopOrigin = await listen(loop);
  t.after(() => close(loop));
  assert.equal((await call(loopOrigin, '/responses', {body: '{}'})).status, 503);
  const handshake = await new Promise((resolve, reject) => {
    const socket = net.connect(proxy.address().port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => socket.write('GET /responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(handshake, /^HTTP\/1.1 426 Upgrade Required\r\n/);
});
test('configuration attach/restore preserves BOM, CRLF, comments and unrelated providers', t => {
  const directory = fixture(t);
  const configPath = path.join(directory, 'config.toml');
  const backupPath = path.join(directory, 'routes.json');
  const original = '\uFEFFmodel_provider = "custom"\r\nmodel = "example"\r\n'
    + '[model_providers.other]\r\nbase_url = \'http://127.0.0.1:15721/v1\' # keep\r\n'
    + '[model_providers."custom"]\r\nbase_url = \'http://127.0.0.1:15721/v1\' # keep\r\nwire_api = "responses"\r\n';
  fs.writeFileSync(configPath, original);
  const options = {configPath, backupPath, filterOrigin: 'http://127.0.0.1:18181', getUpstream: () => 'http://127.0.0.1:15721'};
  const router = new ConfigRouter(options);
  router.sync();
  const attached = fs.readFileSync(configPath, 'utf8');
  assert.equal(providerBase(attached).url, 'http://127.0.0.1:18181/v1');
  assert.equal(providerBase(attached, 'other').url, 'http://127.0.0.1:15721/v1');
  assert.equal(router.state, 'filtering');
  router.sync();
  assert.equal(fs.readFileSync(configPath, 'utf8'), attached);
  new ConfigRouter(options).restore(); // Recovers even after the original process is lost.
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  router.sync();
  fs.appendFileSync(configPath, '# user edit\r\n');
  router.restore();
  assert.equal(fs.readFileSync(configPath, 'utf8'), original + '# user edit\r\n');
  router.sync();
  fs.writeFileSync(configPath, original.replaceAll('http://127.0.0.1:15721/v1', 'https://provider.example/v1'));
  const direct = fs.readFileSync(configPath, 'utf8');
  router.sync();
  assert.equal(router.state, 'waiting-for-ccswitch');
  router.restore();
  assert.equal(fs.readFileSync(configPath, 'utf8'), direct);
});
test('CC Switch rewrites are reattached; unsupported config and missing backup do not get overwritten', t => {
  const directory = fixture(t), configPath = path.join(directory, 'config.toml');
  const options = {configPath, backupPath: path.join(directory, 'routes.json'),
    filterOrigin: 'http://127.0.0.1:18181', getUpstream: () => 'http://127.0.0.1:15721'};
  const router = new ConfigRouter(options);
  const original = 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:15721/v1"\n';
  fs.writeFileSync(configPath, original);
  router.sync();
  fs.writeFileSync(configPath, original + '# new provider choice\n');
  router.sync();
  assert.equal(providerBase(fs.readFileSync(configPath, 'utf8')).url, 'http://127.0.0.1:18181/v1');
  router.restore();
  assert.equal(fs.readFileSync(configPath, 'utf8'), original + '# new provider choice\n');
  fs.writeFileSync(configPath, original.replace('15721', '18181'));
  assert.throws(() => new ConfigRouter({...options, backupPath: path.join(directory, 'missing.json')}).sync(), /backup/);
  const duplicate = original + 'base_url = "http://127.0.0.1:15721/v1"\n';
  fs.writeFileSync(configPath, duplicate);
  assert.throws(() => router.sync(), /Duplicate/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), duplicate);
});
test('offline recovery restores only scratch configuration without starting service', async t => {
  const directory = fixture(t);
  const configPath = path.join(directory, 'config.toml');
  const runtime = path.join(directory, 'runtime');
  const original = 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:15721/v1"\n';
  fs.writeFileSync(configPath, original);
  const options = parseArgs(['stop', '--config', configPath, '--runtime', runtime]);
  new ConfigRouter({configPath, backupPath: path.join(runtime, 'routes.json'),
    filterOrigin: options.filterOrigin, getUpstream: () => 'http://127.0.0.1:15721'}).sync();
  assert.equal((await stop(options)).restored, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

function mockDatabase(t) {
  const {DatabaseSync} = require('node:sqlite');
  let db;
  t.after(() => db?.close());
  const filename = path.join(fixture(t), 'mock.db');
  db = new DatabaseSync(filename);
  db.exec("CREATE TABLE proxy_config(app_type TEXT, auto_failover_enabled INTEGER); INSERT INTO proxy_config VALUES ('codex', 0); CREATE TABLE providers(app_type TEXT, is_current INTEGER, settings_config TEXT, id TEXT DEFAULT 'mock-provider');");
  const select = (url, extra = '', id = 'mock-provider') => {
    db.exec('DELETE FROM providers');
    const config = 'model_provider = "actual"\n[model_providers.actual]\nbase_url = ' + JSON.stringify(url) + '\n' + extra;
    db.prepare('INSERT INTO providers(app_type, is_current, settings_config, id) VALUES (?, 1, ?, ?)').run('codex', JSON.stringify({config, auth: {OPENAI_API_KEY: 'mock-never-output'}}), id);
  };
  return {db, filename, select};
}

test('fresh installations have no built-in domain or header rules, including formerly configured hosts', t => {
  const {db, filename, select} = mockDatabase(t);
  for (const url of ['https://agentrouter.org/v1', 'https://api.agentrouter.org/v1', 'https://ANYROUTER.TOP', 'https://a.b.anyrouter.top', 'https://ai.apizn.com/v1', 'https://api.apizn.com', 'https://ps.air-outer.com/v1', 'https://air-outer.com', 'https://api.ark717.com/', 'https://ark717.com/v1', 'https://venlacy.com/v1', 'https://ai.venlacy.com/v1', 'https://AI.VENLACY.COM/v1']) {
    select(url);
    assert.equal(readFilterPolicy(filename).filter, false, url);
    assert.equal(readFilterPolicy(filename).stripResponsesLiteHeader, undefined, url);
  }
  for (const url of ['https://agentrouter.org.evil.test', 'https://evilagentrouter.org', 'https://anyrouter.top.evil', 'https://-bad.anyrouter.top', 'https://bad_.agentrouter.org', 'https://apizn.com.evil.test', 'https://air-outer.com.evil.test', 'https://evilair-outer.com', 'https://ark717.com.evil.test', 'https://evilark717.com', 'https://api.ark7171.com', 'https://venlacy.com.evil.test', 'https://evilvenlacy.com', 'https://ai.venlacy1.com', 'https://api.openai.com', 'http://127.0.0.1:15721', 'https://127.0.0.1:18190', 'http://127.0.0.1:18191', 'http://localhost:18190', 'not-a-url']) {
    select(url);
    assert.equal(readFilterPolicy(filename).filter, false, url);
  }
  for (const url of ['http://127.0.0.1:18190', 'http://127.0.0.1:18190/v1']) {
    select(url);
    assert.equal(readFilterPolicy(filename).filter, false, 'Local addresses require an explicit user override: ' + url);
  }
  select('https://anyrouter.top');
  db.exec('UPDATE proxy_config SET auto_failover_enabled = 1');
  assert.equal(readFilterPolicy(filename).reason, 'auto-failover-or-unknown');
  db.exec('UPDATE proxy_config SET auto_failover_enabled = 0; UPDATE providers SET is_current = 0');
  assert.equal(readFilterPolicy(filename).filter, false);
  select('https://agentrouter.org', 'base_url = "https://anyrouter.top"');
  assert.equal(readFilterPolicy(filename).filter, false);
  db.exec("UPDATE providers SET settings_config = 'invalid'");
  assert.equal(readFilterPolicy(filename).filter, false);
  assert.equal(readFilterPolicy(path.join(path.dirname(filename), 'missing.db')).reason, 'database-missing');
});

test('user-selected history compatibility applies to any provider and is disabled for failover', t => {
  const {db, filename, select} = mockDatabase(t);
  const overrides = {'mock-provider': {historyFilter: true, preserveEncryptedInclude: true, stripResponsesLiteHeader: false}};
  for (const url of ['https://ugq.ai', 'https://new-provider.example/v1', 'https://another.example:8443']) {
    select(url);
    assert.equal(readFilterPolicy(filename).filter, false);
    assert.deepEqual(readFilterPolicy(filename, overrides), {filter: true, mode: 'filtering',
      reason: 'user-override', provider: new URL(url).hostname, preserveEncryptedInclude: true, stripResponsesLiteHeader: false});
  }
  db.exec('UPDATE proxy_config SET auto_failover_enabled = 1');
  assert.equal(readFilterPolicy(filename, overrides).filter, false);
});

test('user-enabled filter removes historical ciphertext but preserves agent text, tool pairs and new include', async t => {
  const {filename, select} = mockDatabase(t);
  select('https://ugq.ai');
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks));
    const bad = JSON.stringify(received.input).includes('foreign-cipher');
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end(bad ? 'event: error\ndata: {"message":"encrypted content hydration failed"}\n\n'
      : 'event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  const upstreamOrigin = await listen(upstream);
  const overrides = {'mock-provider': {historyFilter: true, preserveEncryptedInclude: true, stripResponsesLiteHeader: false}};
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => readFilterPolicy(filename, overrides),
    getModelAliases: () => new Map([['ccs-agent-router-github-code/gpt-6-astra', 'gpt-6-astra']])});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const agent = {type: 'agent_message', id: 'amsg_old', author: '/root/helper', recipient: '/root',
    content: [{type: 'input_text', text: 'History to keep'}, {type: 'encrypted_content', encrypted_content: 'foreign-cipher'}]};
  const body = {...sample, model: 'ccs-agent-router-github-code/gpt-6-astra', input: [agent, ...sample.input]};
  assert.match((await call(upstreamOrigin, '/v1/responses', {body: JSON.stringify(body)})).body, /hydration failed/);
  const result = await call(origin, '/v1/responses', {body: zlib.zstdCompressSync(Buffer.from(JSON.stringify(body))),
    headers: {'content-encoding': 'zstd'}});
  assert.match(result.body, /response.completed/);
  assert.deepEqual(received, {...filterResponsesRequest(body, {preserveEncryptedInclude: true}).body, model: 'gpt-6-astra'});
  assert.deepEqual(received.input[0], {type: 'agent_message', author: '/root/helper', recipient: '/root',
    content: [{type: 'input_text', text: 'History to keep'}]});
});

test('header compatibility is opt-in for each provider, regardless of origin', t => {
  const {db, filename, select} = mockDatabase(t);
  for (const url of ['https://hub.oaifree.com', 'https://HUB.OAIFREE.COM/v1', 'https://hub.oaifree.com:443/v1']) {
    select(url);
    assert.equal(readFilterPolicy(filename).filter, false);
    assert.equal(readFilterPolicy(filename).stripResponsesLiteHeader, undefined);
  }
  for (const url of ['http://hub.oaifree.com', 'https://hub.oaifree.com:8443', 'https://oaifree.com',
    'https://api.hub.oaifree.com', 'https://hub.oaifree.com.evil.test', 'https://evilhub.oaifree.com']) {
    select(url);
    const policy = readFilterPolicy(filename);
    assert.equal(policy.filter, false);
    assert.equal(policy.stripResponsesLiteHeader, undefined);
  }
  select('https://hub.oaifree.com');
  const overrides = {'mock-provider': {historyFilter: false, preserveEncryptedInclude: true, stripResponsesLiteHeader: true}};
  assert.deepEqual(readFilterPolicy(filename, overrides), {filter: false, mode: 'compatibility',
    reason: 'user-override', provider: 'hub.oaifree.com', preserveEncryptedInclude: true, stripResponsesLiteHeader: true});
  db.exec('UPDATE proxy_config SET auto_failover_enabled = 1');
  assert.equal(readFilterPolicy(filename, overrides).stripResponsesLiteHeader, undefined);
});

test('user-enabled header compatibility repairs Lite 400 without discarding history or effort', async t => {
  const {filename, select} = mockDatabase(t);
  select('https://header.example');
  const overrides = {'mock-provider': {historyFilter: false, preserveEncryptedInclude: true, stripResponsesLiteHeader: true}};
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(decodeBody(raw, req.headers['content-encoding'], 65536));
    received = {raw, body, headers: req.headers, path: req.url};
    // Emulate a downstream that rejects the private Lite opt-in header.
    const invalid = !!req.headers['x-openai-internal-codex-responses-lite'];
    res.writeHead(invalid ? 400 : 200, {'content-type': invalid ? 'application/json' : 'text/event-stream'});
    res.end(invalid ? JSON.stringify({error: {message:
      'X-OpenAI-Internal-Codex-Responses-Lite requires `reasoning.context` to be `all_turns`.'}})
      : 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  const upstreamOrigin = await listen(upstream);
  const events = [];
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => readFilterPolicy(filename, overrides),
    log: (event, data) => events.push({event, data})});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const request = {...sample, model: 'gpt-6-astra', previous_response_id: 'resp_keep',
    conversation: 'conv_keep', context_management: [{type: 'compaction'}],
    reasoning: {effort: 'xhigh', summary: 'auto', context: 'all_turns'},
    input: [...sample.input, {type: 'agent_message', id: 'amsg_keep', content: [
      {type: 'input_text', text: 'keep this history'}, {type: 'encrypted_content', encrypted_content: 'keep'}
    ]}]};
  const snapshot = JSON.stringify(request);
  const raw = Buffer.from(snapshot);
  const headers = {'X-OpenAI-Internal-Codex-Responses-Lite': 'true', authorization: 'Bearer mock-secret'};
  const failure = await call(upstreamOrigin, '/responses', {body: raw, headers});
  assert.equal(failure.status, 400);
  assert.match(failure.body, /reasoning.context/);
  for (const [encoding, body] of [['identity', raw], ['gzip', zlib.gzipSync(raw)],
    ['deflate', zlib.deflateSync(raw)], ['br', zlib.brotliCompressSync(raw)], ['zstd', zlib.zstdCompressSync(raw)]]) {
    const response = await call(origin, '/v1/responses?keep=1', {body,
      headers: {...headers, 'content-encoding': encoding, 'content-length': String(body.length)}});
    assert.equal(response.status, 200, response.body);
    assert.match(response.body, /response.completed/);
    assert.deepEqual(received.body, request);
    assert.deepEqual(received.raw, body);
    assert.equal(received.headers['x-openai-internal-codex-responses-lite'], undefined);
    assert.equal(received.headers.authorization, headers.authorization);
    assert.equal(received.headers['content-encoding'], encoding);
    assert.equal(Number(received.headers['content-length']), received.raw.length);
    assert.equal(received.path, '/v1/responses?keep=1');
  }
  // Missing/null reasoning does not cause the shim to invent body fields.
  for (const reasoning of [undefined, null]) {
    const wire = Buffer.from(JSON.stringify({...request, reasoning}));
    const response = await call(origin, '/responses', {body: wire});
    assert.equal(response.status, 200);
    assert.deepEqual(received.raw, wire);
    assert.deepEqual(received.body.input, request.input);
  }
  // Header cleanup never changes already complete request bodies either.
  const complete = Buffer.from(JSON.stringify({...request, reasoning: {...request.reasoning, context: 'all_turns'}}, null, 2));
  const compressed = zlib.gzipSync(complete);
  assert.equal((await call(origin, '/responses', {body: compressed,
    headers: {...headers, 'content-encoding': 'gzip'}})).status, 200);
  assert.deepEqual(received.raw, compressed);
  assert.equal(received.headers['content-encoding'], 'gzip');
  assert.equal(JSON.stringify(request), snapshot);
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.policy.mode, 'compatibility');
  assert.equal(health.policy.filter, false);
  assert.equal(health.stats.strippedResponsesLiteHeaders, 6);
  assert.equal(health.stats.filteredRequests, 0);
  assert.equal(health.stats.removedReasoningItems, 0);
  assert.equal(health.stats.removedItemIds, 0);
  assert.equal(health.stats.lastUpstreamStatus, 200);
  assert.ok(Number.isFinite(Date.parse(health.stats.lastLiteHeaderStrippedAt)));
  assert.equal(events.filter(x => x.event === 'lite-header-stripped').length, 6);
  assert.ok(events.every(x => !JSON.stringify(x).includes('mock-secret')));
  for (const body of [{reasoning: 'bad'}, {reasoning: []}, []]) {
    const wire = Buffer.from(JSON.stringify(body));
    assert.equal((await call(origin, '/responses', {body: wire})).status, 200);
    assert.deepEqual(received.raw, wire);
  }
});

test('user-enabled header cleanup preserves opaque bodies and leaves other endpoints/providers/failover untouched', async t => {
  const {db, filename, select} = mockDatabase(t);
  const overrides = {'mock-provider': {historyFilter: false, preserveEncryptedInclude: true, stripResponsesLiteHeader: true}};
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {raw: Buffer.concat(chunks), encoding: req.headers['content-encoding'],
      lite: req.headers['x-openai-internal-codex-responses-lite']};
    res.end('{}');
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => readFilterPolicy(filename, overrides)});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const raw = Buffer.from('opaque-not-json');
  const headers = {'x-openai-internal-codex-responses-lite': 'true', 'content-encoding': 'unknown'};
  select('https://header.example');
  assert.equal((await call(origin, '/responses', {body: raw, headers})).status, 200);
  assert.deepEqual(received.raw, raw);
  assert.equal(received.encoding, 'unknown');
  assert.equal(received.lite, undefined);
  for (const route of ['/models', '/v1/responses/compact']) {
    assert.equal((await call(origin, route, {body: raw, headers})).status, 200);
    assert.deepEqual(received.raw, raw);
    assert.equal(received.encoding, 'unknown');
    assert.equal(received.lite, 'true');
  }
  for (const mode of ['other', 'unknown', 'failover']) {
    select('https://header.example', '', mode === 'other' ? 'unconfigured-provider' : 'mock-provider');
    if (mode === 'unknown') db.exec('UPDATE providers SET is_current = 0');
    db.exec('UPDATE proxy_config SET auto_failover_enabled = ' + (mode === 'failover' ? 1 : 0));
    assert.equal((await call(origin, '/responses', {body: raw, headers})).status, 200);
    assert.deepEqual(received.raw, raw);
    assert.equal(received.encoding, 'unknown');
    assert.equal(received.lite, 'true');
  }
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.stats.strippedResponsesLiteHeaders, 1);
  assert.equal(health.stats.blockedRequests, 0);
});

test('header cleanup is cancelled when the routing policy changes during upload', async t => {
  let reads = 0, received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {body: Buffer.concat(chunks), encoding: req.headers['content-encoding'],
      lite: req.headers['x-openai-internal-codex-responses-lite']};
    res.end('{}');
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => {
    reads++;
    return reads === 1 ? {filter: false, provider: 'header.example', stripResponsesLiteHeader: true}
      : {filter: false, reason: 'other-provider'};
  }});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const raw = zlib.gzipSync(Buffer.from(JSON.stringify(sample)));
  assert.equal((await call(origin, '/responses', {body: raw, headers: {'content-encoding': 'gzip',
    'X-OpenAI-Internal-Codex-Responses-Lite': 'true'}})).status, 200);
  assert.equal(reads, 2);
  assert.deepEqual(received.body, raw);
  assert.equal(received.encoding, 'gzip');
  assert.equal(received.lite, 'true');
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.stats.strippedResponsesLiteHeaders, 0);
  assert.equal(health.policy.mode, 'passthrough');
});

test('provider switches per request; non-target, unknown and failover pass compressed references/compaction byte-for-byte', async t => {
  const {db, filename, select} = mockDatabase(t);
  const overrides = {
    'remove-include': {historyFilter: true, preserveEncryptedInclude: false, stripResponsesLiteHeader: false},
    'keep-include': {historyFilter: true, preserveEncryptedInclude: true, stripResponsesLiteHeader: false}
  };
  let received, policyReads = 0;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {body: Buffer.concat(chunks), encoding: req.headers['content-encoding']};
    res.end('{}');
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => { policyReads++; return readFilterPolicy(filename, overrides); }});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  for (const [url, id] of [['https://filter.example', 'remove-include'], ['https://second.example/v1', 'remove-include'],
    ['https://unconfigured.example', 'unconfigured'], ['https://preserve.example', 'keep-include'], ['invalid', 'remove-include']]) {
    select(url, '', id);
    const raw = Buffer.from(JSON.stringify(sample, null, 2));
    const before = policyReads;
    assert.equal((await call(origin, '/responses', {body: raw})).status, 200);
    const policy = readFilterPolicy(filename, overrides);
    assert.equal(policyReads, before + (policy.filter ? 2 : 1));
    if (policy.filter) assert.deepEqual(JSON.parse(received.body), filterResponsesRequest(sample, {preserveEncryptedInclude: policy.preserveEncryptedInclude}).body);
    else assert.deepEqual(received.body, raw);
  }
  const raw = Buffer.from(JSON.stringify({...sample, previous_response_id: 'resp', conversation: 'conv', context_management: [{type: 'compaction'}], input: [...sample.input, {type: 'item_reference', id: 'keep'}, {type: 'compaction', encrypted_content: 'keep'}]}, null, 2));
  for (const mode of ['other', 'unknown', 'failover']) {
    select('https://filter.example', '', mode === 'other' ? 'unconfigured' : 'remove-include');
    if (mode === 'unknown') db.exec('UPDATE providers SET is_current = 0');
    db.exec('UPDATE proxy_config SET auto_failover_enabled = ' + (mode === 'failover' ? 1 : 0));
    for (const [encoding, body] of [['identity', raw], ['gzip', zlib.gzipSync(raw)], ['deflate', zlib.deflateSync(raw)], ['br', zlib.brotliCompressSync(raw)], ['zstd', zlib.zstdCompressSync(raw)], ['unknown', Buffer.from('not-json')]]) {
      for (const route of ['/responses', '/v1/responses/compact']) {
        assert.equal((await call(origin, route, {body, headers: {'content-encoding': encoding}})).status, 200);
        assert.deepEqual(received.body, body);
        assert.equal(received.encoding, encoding);
      }
    }
  }
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.policy.mode, 'passthrough');
  assert.equal(health.policy.reason, 'auto-failover-or-unknown');
  assert.equal(health.stats.filteredRequests, 3);
  assert.equal(health.filterVersion, FILTER_VERSION);
});
test('explicit include preservation applies only to configured provider IDs', async t => {
  const {db, filename, select} = mockDatabase(t);
  const overrides = {
    'remove-include': {historyFilter: true, preserveEncryptedInclude: false, stripResponsesLiteHeader: false},
    'keep-include': {historyFilter: true, preserveEncryptedInclude: true, stripResponsesLiteHeader: false}
  };
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = null;
    try { body = JSON.parse(raw.toString('utf8')); } catch {}
    received = {raw, body};
    // A strict endpoint rejects requests that do not ask for encrypted reasoning output.
    const keepsInclude = Array.isArray(body?.include) && body.include.includes('reasoning.encrypted_content');
    res.writeHead(keepsInclude ? 200 : 400, {'content-type': 'application/json'});
    res.end(JSON.stringify(keepsInclude ? {keepsInclude} : {error: {type: 'invalid_request_error', message: 'invalid codex request'}}));
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => readFilterPolicy(filename, overrides)});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const raw = Buffer.from(JSON.stringify(sample));
  select('https://strict.example', '', 'remove-include');
  assert.equal((await call(origin, '/responses', {body: raw})).status, 400);
  assert.deepEqual(received.body, filterResponsesRequest(sample).body);
  assert.deepEqual(received.body.include, ['message.output_text.logprobs']);
  select('https://strict.example', '', 'keep-include');
  assert.equal((await call(origin, '/responses', {body: raw})).status, 200);
  assert.deepEqual(received.body, filterResponsesRequest(sample, {preserveEncryptedInclude: true}).body);
  assert.deepEqual(received.body.include, sample.include);
  assert.equal(received.body.store, false);
  assert.deepEqual(received.body.reasoning, sample.reasoning);
  assert.equal(received.body.input.some(item => item.type === 'reasoning'), false);
  assert.equal(received.body.input.some(item => item.id !== undefined), false);
  assert.equal(received.body.input[1].call_id, received.body.input[2].call_id);
  select('https://strict.example', '', 'unconfigured');
  assert.equal((await call(origin, '/responses', {body: raw})).status, 200);
  assert.deepEqual(received.raw, raw);
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.filterVersion, FILTER_VERSION);
  assert.equal(health.stats.filteredRequests, 2);
  assert.equal(health.stats.removedReasoningItems, 2);
  assert.equal(health.stats.removedItemIds, 10);
  assert.equal(health.stats.upstreamHttpErrors, 1);
});

test('default policy stays passthrough but a failed policy cannot forward unchecked compact input', async t => {
  let received = 0;
  const upstream = http.createServer((req, res) => { received++; req.pipe(res); });
  const upstreamOrigin = await listen(upstream);
  t.after(() => close(upstream));
  for (const getFilterPolicy of [undefined, () => { throw new Error('mock'); }]) {
    const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy});
    const origin = await listen(proxy);
    try {
      const response = await call(origin, '/responses/compact', {body: 'raw-not-json'});
      if (!getFilterPolicy) assert.equal(response.body, 'raw-not-json');
      else {
        assert.equal(response.status, 503);
        assert.equal(JSON.parse(response.body).error.code, 'filter_policy_unavailable');
      }
    }
    finally { await close(proxy); }
  }
  assert.equal(received, 1);
});

test('multiline TOML examples cannot opt a different provider into filtering', t => {
  const {db, filename} = mockDatabase(t);
  for (const quote of ["'''", '"""']) {
    const config = 'model_provider = "actual"\ninstructions = ' + quote + '\nmodel_provider = "fake"\n[model_providers.fake]\nbase_url = "https://anyrouter.top"\n' + quote + '\n[model_providers.actual]\nbase_url = "https://example.com"\n';
    db.exec('DELETE FROM providers');
    db.prepare('INSERT INTO providers(app_type, is_current, settings_config) VALUES (?, 1, ?)').run('codex', JSON.stringify({config}));
    assert.equal(readFilterPolicy(filename).filter, false);
    assert.equal(readFilterPolicy(filename).reason, 'complex-toml-unidentified');
  }
});

test('policy is rechecked after upload before decoding or filtering history', async t => {
  let reads = 0, received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {body: Buffer.concat(chunks), encoding: req.headers['content-encoding']};
    res.end('{}');
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = makeProxy({getUpstream: () => upstreamOrigin, getFilterPolicy: () => {
    reads++;
    return reads === 1 ? {filter: true, provider: 'anyrouter.top'} : {filter: false, reason: 'other-provider'};
  }});
  const origin = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const raw = zlib.gzipSync(Buffer.from(JSON.stringify({...sample, previous_response_id: 'keep'})));
  assert.equal((await call(origin, '/responses', {body: raw, headers: {'content-encoding': 'gzip'}})).status, 200);
  assert.equal(reads, 2);
  assert.deepEqual(received.body, raw);
  assert.equal(received.encoding, 'gzip');
  const health = JSON.parse((await call(origin, ADMIN + '/health', {method: 'GET'})).body);
  assert.equal(health.stats.filteredRequests, 0);
  assert.equal(health.policy.mode, 'passthrough');
});

test('control recognizes legacy services and refuses silently changing routing options', async t => {
  const directory = fixture(t);
  let advertised;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(advertised));
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const options = parseArgs(['start', '--runtime', directory, '--port', new URL(origin).port,
    '--config', path.join(directory, 'config.toml'), '--cc-db', path.join(directory, 'first.db'), '--upstream', origin]);
  fs.writeFileSync(path.join(directory, 'service.json'), JSON.stringify({filterOrigin: origin, instance: 'mock-instance'}));
  for (const service of ['ccswitch-codex-reasoning-filter-v1', 'ccswitch-codex-filter']) {
    advertised = {service, instance: 'mock-instance', upstream: origin, filterOrigin: origin, configPath: options.configPath};
    assert.equal((await status(options)).running, true);
    await assert.rejects(start(options), /unknown database\/upstream/);
    advertised.routingOptions = {databasePath: options.databasePath, upstreamOverride: origin};
    await assert.rejects(start(options), /unknown database\/upstream/);
    advertised.backend = 'ccswitch';
    advertised.routingOptions = {...advertised.routingOptions, backend: options.backend};
    assert.equal((await start(options)).running, true);
    await assert.rejects(start({...options, databasePath: path.join(directory, 'second.db')}), /database\/upstream/);
    await assert.rejects(start({...options, upstream: 'http://127.0.0.1:12345'}), /database\/upstream/);
  }
  assert.equal(require('../src/proxy.cjs').SERVICE, 'ccswitch-codex-reasoning-filter-v1');
});

test('stale service.json whose PID was reused by another process no longer blocks stop or start', {timeout: 30000}, async t => {
  const directory = fixture(t);
  const runtime = path.join(directory, 'runtime');
  const configPath = path.join(directory, 'config.toml');
  fs.mkdirSync(runtime, {recursive: true});
  const original = 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:15721/v1"\n';
  fs.writeFileSync(configPath, original);
  const probe = http.createServer();
  const origin = await listen(probe);
  await close(probe); // Nothing listens here, so health checks fail fast.
  const options = parseArgs(['stop', '--config', configPath, '--runtime', runtime, '--port', new URL(origin).port]);
  const stateFile = path.join(runtime, 'service.json');
  // The test runner is a live node process with this PID, but it is not `filter.cjs serve` (Windows reuses PIDs after reboot).
  const stale = {service: 'ccswitch-codex-reasoning-filter-v1', pid: process.pid, instance: 'stale', token: 'mock',
    filterOrigin: origin, configPath, startedAt: new Date(Date.now() - 86400000).toISOString()};
  fs.writeFileSync(stateFile, JSON.stringify(stale));
  assert.equal(ownsProcess(stale), false);
  assert.equal((await status(options)).state, 'stale-state');
  assert.deepEqual(await stop(options), {running: false, state: 'stopped', restored: false});
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);

  // A genuine `filter.cjs serve` process that stopped answering is still never killed or overridden.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'filter.cjs', 'serve'], {stdio: 'ignore'});
  t.after(() => child.kill());
  await once(child, 'spawn');
  const live = {...stale, pid: child.pid, startedAt: new Date().toISOString()};
  fs.writeFileSync(stateFile, JSON.stringify(live));
  assert.equal(ownsProcess(live), true);
  assert.equal((await status(options)).state, 'unresponsive');
  await assert.rejects(stop(options), /alive but not responding/);
  assert.equal(fs.existsSync(stateFile), true);
  // Matching command line but a start time from another boot or generation is still stale.
  if (process.platform === 'win32') assert.equal(ownsProcess({...live, startedAt: stale.startedAt}), false);
});

test('reused PID is still recognized as stale when the slow Windows process query times out', {skip: process.platform !== 'win32', timeout: 30000}, () => {
  // Cold CI runners can exceed the CIM timeout; the start-time check must not depend on it.
  const script = `
    const cp = require('node:child_process');
    const original = cp.execFileSync;
    cp.execFileSync = (file, args, options) => {
      if (String(args?.at(-1)).includes('Get-CimInstance')) throw Object.assign(new Error('simulated timeout'), {code: 'ETIMEDOUT'});
      return original(file, args, options);
    };
    const {ownsProcess} = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'filter.cjs'))});
    const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
    console.log(JSON.stringify({
      reused: ownsProcess({pid: process.pid, startedAt: new Date(Date.now() - 86400000).toISOString()}),
      unverifiedSameStart: ownsProcess({pid: process.pid, startedAt})
    }));`;
  const result = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', windowsHide: true, timeout: 25000});
  assert.equal(result.status, 0, result.stderr);
  // A different start time is rejected without the command line; an unverifiable same-start process stays protected.
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), {reused: false, unverifiedSameStart: true});
});
