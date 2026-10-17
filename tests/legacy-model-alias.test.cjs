'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const {once} = require('node:events');
const {DatabaseSync} = require('node:sqlite');
const {makeProxy, ADMIN} = require('../src/proxy.cjs');
const {readLegacyModelAliases} = require('../src/config.cjs');

const alias = 'ccs-agent-router-github-code/gpt-6-astra';
const model = 'gpt-6-astra';
const mappings = new Map([[alias, model]]);
async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}
async function send(origin, route, body, headers = {}) {
  const r = await fetch(origin + route, {method: 'POST', body, headers});
  return {status: r.status, text: await r.text()};
}

test('downgrade aliases require explicit config, exact model identity and database version 19', t => {
  assert.ok(process.env.PI_SCRATCH_DIR);
  const root = fs.realpathSync(process.env.PI_SCRATCH_DIR);
  const dir = fs.mkdtempSync(path.join(root, 'aliases-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(dir)), root);
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const filename = path.join(dir, 'aliases.json'), dbPath = path.join(dir, 'mock.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA user_version=19');
  const config = {enabled: true, databaseVersion: 19, aliases: [[alias, model],
    ['ccs-other/gpt-6-astra', 'gpt-6-luna'], ['openai/gpt-6-astra', model]]};
  fs.writeFileSync(filename, JSON.stringify(config));
  assert.deepEqual(readLegacyModelAliases(filename, dbPath), mappings);
  db.exec('PRAGMA user_version=20');
  assert.equal(readLegacyModelAliases(filename, dbPath).size, 0);
  db.exec('PRAGMA user_version=19');
  fs.writeFileSync(filename, JSON.stringify({...config, enabled: false}));
  assert.equal(readLegacyModelAliases(filename, dbPath).size, 0);
  db.close();
  assert.equal(readLegacyModelAliases(filename + '.missing', dbPath).size, 0);
});

test('old pre-compaction model receives completed SSE while all history fields survive', async t => {
  const seen = [];
  const upstream = await listen(t, http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({body: JSON.parse(Buffer.concat(chunks)), headers: req.headers, url: req.url});
    const ok = seen.at(-1).body.model === model;
    res.writeHead(ok ? 200 : 503, {'content-type': ok ? 'text/event-stream' : 'application/json'});
    res.end(ok ? 'event: response.completed\ndata: {"type":"response.completed"}\n\n' : '{"error":"model_not_found"}');
  }));
  const proxy = await listen(t, makeProxy({getUpstream: () => upstream, getModelAliases: () => mappings}));
  const body = {model: alias, stream: true, store: false, reasoning: {effort: 'xhigh'},
    input: [{type: 'reasoning', encrypted_content: 'keep'}, {role: 'user', content: 'keep'},
      {type: 'function_call', call_id: 'pair', name: 'fn', arguments: '{}'},
      {type: 'function_call_output', call_id: 'pair', output: 'keep'}]};
  for (const [encoding, encode] of [['identity', b => b], ['gzip', zlib.gzipSync], ['zstd', zlib.zstdCompressSync]]) {
    const r = await send(proxy, '/v1/responses', encode(Buffer.from(JSON.stringify(body))),
      {'content-encoding': encoding, authorization: 'Bearer mock'});
    assert.equal(r.status, 200);
    assert.match(r.text, /response.completed/);
    assert.deepEqual(seen.at(-1).body, {...body, model});
    assert.equal(seen.at(-1).headers.authorization, 'Bearer mock');
    assert.equal(seen.at(-1).headers['content-encoding'], undefined);
  }
  const r = await send(proxy, '/v1/responses/compact', JSON.stringify(body));
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1).url, '/v1/responses/compact');
  const health = await (await fetch(proxy + ADMIN + '/health')).json();
  assert.equal(health.stats.normalizedModelAliases, 4);
  assert.equal(health.stats.filteredRequests, 0);
});

test('normal models, unknown aliases, opaque content and other endpoints preserve original bytes', async t => {
  const seen = [];
  const upstream = await listen(t, http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({body: Buffer.concat(chunks), headers: req.headers});
    res.end('ok');
  }));
  const proxy = await listen(t, makeProxy({getUpstream: () => upstream, getModelAliases: () => mappings}));
  for (const [route, text] of [['/v1/responses', JSON.stringify({model}, null, 2)],
    ['/v1/responses', '{"model":"ccs-unknown/gpt-6-astra"}'],
    ['/v1/responses', 'opaque'], ['/v1/chat/completions', JSON.stringify({model: alias})]]) {
    const bytes = zlib.gzipSync(Buffer.from(text));
    assert.equal((await send(proxy, route, bytes, {'content-encoding': 'gzip'})).status, 200);
    assert.deepEqual(seen.at(-1).body, bytes);
    assert.equal(seen.at(-1).headers['content-encoding'], 'gzip');
  }
});

test('alias normalization composes with history filtering and is cancelled when disabled during upload', async t => {
  let last;
  const upstream = await listen(t, http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    last = JSON.parse(Buffer.concat(chunks));
    res.end('ok');
  }));
  const proxy = await listen(t, makeProxy({getUpstream: () => upstream,
    getModelAliases: () => mappings, getFilterPolicy: () => ({filter: true})}));
  const body = {model: alias, input: [{type: 'reasoning', encrypted_content: 'foreign'},
    {role: 'user', content: 'keep'}]};
  assert.equal((await send(proxy, '/responses', JSON.stringify(body))).status, 200);
  assert.deepEqual(last, {model, store: false, input: [{role: 'user', content: 'keep'}]});
  let reads = 0;
  const disabled = await listen(t, makeProxy({getUpstream: () => upstream,
    getModelAliases: () => ++reads === 1 ? mappings : new Map()}));
  assert.equal((await send(disabled, '/responses', JSON.stringify(body))).status, 200);
  assert.deepEqual(last, body);
});
