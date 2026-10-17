import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as mod from '../codex-history.middleware.js';

const cases = JSON.parse(readFileSync(new URL('../cases.json', import.meta.url), 'utf8'));
test('only the request hook is exported', () => {
  assert.deepEqual(Object.keys(mod), ['onRequest']);
});
for (const c of cases) {
  test(c.name, () => {
    const original = structuredClone(c.request);
    let rejected;
    const context = {protocol: 'responses', path: '/v1/responses', ...c.ctx,
      options: c.options || {}, state: {},
      reject(status, message) { rejected = {status, message}; }};
    const result = mod.onRequest(c.request, context);
    if (c.reject) {
      assert.equal(rejected?.status, c.reject.status);
      if (c.reject.message) assert.ok(rejected?.message.includes(c.reject.message));
    } else {
      assert.equal(rejected, undefined);
      assert.deepEqual(result === undefined ? c.request : result, c.expect_request ?? original);
    }
    assert.deepEqual(c.request, original, 'the input history must remain unchanged');
  });
}
