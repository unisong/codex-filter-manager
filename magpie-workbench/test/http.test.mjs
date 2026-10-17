import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createService} from '../server/http.mjs';
import {localGateway} from '../server/gateway.mjs';
import {consoleURL} from '../tools/open.mjs';

test('workbench authenticates one-time opens, enforces same-origin writes and hides secrets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-http-'));
  let probes = 0, modelReads = 0;
  const mock = http.createServer((req, res) => {
    if (req.method !== 'GET') { probes++; res.writeHead(500); return res.end(); }
    modelReads++; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({data: [{id: 'private-provider/gpt-6-astra'}]}));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const service = await createService({directory, gateFile: path.join(directory, 'gate.middleware.js'),
    magpieDirectory: path.join(directory, 'empty'), options: {gatewayUrl: 'http://127.0.0.1:' + mock.address().port, gatewayKey: 'PRIVATE_KEY_MARKER'},
    probe: () => assert.fail('saving settings must not call a model')});
  const api = (route, body, headers = {}) => fetch(service.origin + route, {method: body === undefined ? 'GET' : 'POST',
    headers: {...headers, ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body)});
  try {
    assert.equal((await api('/api/state')).status, 401);
    const link = await consoleURL(directory), key = new URL(link).hash.slice(6);
    assert.equal((await api('/api/session', {key})).status, 403);
    const response = await api('/api/session', {key}, {Origin: service.origin});
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await api('/api/session', {key}, {Origin: service.origin})).status, 401);
    const headers = {cookie, Origin: service.origin};
    const state = await (await api('/api/state', undefined, {cookie})).json();
    assert.equal(state.targets.length, 0);
    assert.ok(!JSON.stringify(state).includes('PRIVATE_KEY_MARKER'));
    const listed = await (await api('/api/models', undefined, {cookie})).json();
    assert.deepEqual(listed.models, ['private-provider/gpt-6-astra']);
    assert.equal((await api('/api/budget', {limit: 20}, {cookie, Origin: 'https://evil.example'})).status, 403);
    assert.equal((await api('/api/targets', {model: listed.models[0], expected: 'gpt-6-astra', effort: 'default', mode: 'manual', intervalMinutes: 30}, headers)).status, 200);
    const next = await (await api('/api/state', undefined, {cookie})).json();
    assert.equal(next.targets.length, 1); assert.equal(probes, 0); assert.ok(modelReads >= 2);
    const asset = await api('/app.js');
    assert.match(asset.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await api('/server/http.mjs')).status, 404);
  } finally { await service.close(); await new Promise(r => mock.close(r)); fs.rmSync(directory, {recursive: true}); }
});

test('gateway connection only permits exact loopback origins, never supplier URLs', () => {
  for (const value of ['https://vendor.example/v1', 'http://127.0.0.1:3425/evil', 'http://name:secret@127.0.0.1:3425',
    'http://127.0.0.1:3425/?secret=x', 'file:///secret', 'http://192.168.1.5:3425']) assert.throws(() => localGateway(value));
  assert.equal(localGateway('http://127.0.0.1:3425/v1/'), 'http://127.0.0.1:3425');
});

test('console keeps its address and authenticated browser session after a host restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-restart-'));
  const config = {directory, gateFile: path.join(directory, 'workbench.middleware.js'), options: {gatewayUrl: 'http://127.0.0.1:1'}};
  let service = await createService(config);
  try {
    const origin = service.origin, key = new URL(service.openURL()).hash.slice(6);
    const response = await fetch(origin + '/api/session', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({key})});
    const cookie = response.headers.get('set-cookie').split(';')[0];
    await service.close(); service = await createService(config);
    assert.equal(service.origin, origin);
    const state = await fetch(origin + '/api/state', {headers: {cookie}});
    assert.equal(state.status, 200); assert.equal((await state.json()).daily.used, 0);
  } finally { await service.close(); fs.rmSync(directory, {recursive: true}); }
});

test('a second CLI host cannot rewrite the running engine state or probe gate', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-single-host-'));
  const config = {directory, gateFile: path.join(directory, 'workbench.middleware.js'), options: {gatewayUrl: 'http://127.0.0.1:1'}};
  const service = await createService(config);
  try {
    const beforeGate = fs.readFileSync(config.gateFile, 'utf8');
    const beforeState = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
    const beforeRuntime = fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8');
    await assert.rejects(() => createService(config), error => error.code === 'EADDRINUSE');
    assert.equal(fs.readFileSync(config.gateFile, 'utf8'), beforeGate);
    assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), beforeState);
    assert.equal(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8'), beforeRuntime);
    assert.equal((await fetch(service.origin + '/health')).status, 200);
  } finally { await service.close(); fs.rmSync(directory, {recursive: true}); }
});
