import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = new URL('./deferred-schema-smoke.py', import.meta.url);
const source = fs.readFileSync(script, 'utf8');

test('native Magpie smoke test stays local, disposable, and opt-in', () => {
  assert.match(source, /ThreadingHTTPServer\(\('127\.0\.0\.1', 0\)/);
  assert.match(source, /HTTP_PROXY|ProxyHandler\(\{\}\)/);
  assert.match(source, /plugins\.json/);
  assert.match(source, /deepSeekObjectRoot/);
  assert.match(source, /tool_search_output/);
  assert.match(source, /additional_tools/);
  assert.match(source, /supplierRequests.*0|supplierRequests=0/);
  assert.doesNotMatch(source, /api(?:\\.|[_-])key|authorization/i);
});

test('installed Magpie native check is ignored without an explicit binary', {skip: !process.env.MAGPIE_BINARY}, () => {
  assert.ok(path.isAbsolute(process.env.MAGPIE_BINARY));
});
