import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {onRequest} from '../codex-history.middleware.js';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../history/page/settings.js', import.meta.url), 'utf8'), ctx);
const M = ctx.HistorySettings;
const list = [{id: 'demo', name: 'Demo'}, {id: 'backup', name: 'Backup'}];
const plain = value => JSON.parse(JSON.stringify(value));

test('native page declares only provider names/IDs read and bundles its assets', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.magpie.permissions, ['providers:list']);
  assert.deepEqual(pkg.magpie.options, {providers: {}, aliases: {}});
  for (const file of [pkg.magpie.page.file, pkg.magpie.page.icon, 'history/page/app.js', 'history/page/settings.js', 'history/page/style.css']) {
    assert.ok(existsSync(new URL('../' + file, import.meta.url)), file);
  }
  assert.ok(pkg.files.includes('history'));
});

test('listed providers are off by default; reading never creates rules', () => {
  const opts = {providers: {}, aliases: {}};
  const rows = M.rows(opts, list);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => !r.on && !r.configured && r.include));
  assert.deepEqual(opts, {providers: {}, aliases: {}});
});

test('new rule recommends include while an existing missing/false include stays off', () => {
  const base = {providers: {'magpie:backup': {historyFilter: false}}, aliases: {}};
  const draft = M.change(base, 'demo', 'historyFilter', true);
  assert.deepEqual(plain(draft.providers['magpie:demo']), {historyFilter: true, preserveEncryptedInclude: true});
  assert.equal(M.rows(draft, list).find(r => r.id === 'backup').include, false);
  assert.equal(base.providers['magpie:demo'], undefined);
});

test('aliases use the same single-hop rule as the request hook; saved absent rules remain visible', () => {
  const opts = {providers: {'magpie:demo': {historyFilter: true, preserveEncryptedInclude: true},
    'magpie:removed': {historyFilter: false}}, aliases: {'old-demo': 'demo'}};
  const rows = M.rows(opts, [...list, {id: 'old-demo', name: 'Old name'}]);
  const old = rows.find(r => r.id === 'old-demo');
  assert.equal(old.target, 'demo');
  assert.equal(old.on, true);
  assert.equal(rows.find(r => r.id === 'removed').listed, false);
  const changed = M.change(opts, old.target, 'historyFilter', false);
  assert.equal(M.rows(changed, list).find(r => r.id === 'demo').on, false);
});

test('save merges only edited switches and retains other options and concurrent unrelated edits', () => {
  const base = {providers: {'magpie:demo': {historyFilter: true, preserveEncryptedInclude: true, custom: 1}},
    aliases: {'old-demo': 'demo'}, custom: {safe: 'keep'}};
  const draft = M.change(base, 'demo', 'historyFilter', false);
  const latest = structuredClone(base);
  latest.providers['magpie:demo'].custom = 2;
  latest.providers['magpie:demo'].preserveEncryptedInclude = false;
  latest.providers['magpie:backup'] = {historyFilter: true};
  const saved = M.merge(base, draft, latest);
  assert.equal(saved.providers['magpie:demo'].historyFilter, false);
  assert.equal(saved.providers['magpie:demo'].preserveEncryptedInclude, false);
  assert.equal(saved.providers['magpie:demo'].custom, 2);
  assert.equal(saved.providers['magpie:backup'].historyFilter, true);
  assert.deepEqual(plain(saved.aliases), base.aliases);
  assert.deepEqual(plain(saved.custom), base.custom);
  assert.equal(latest.providers['magpie:demo'].historyFilter, true);
});

test('conflicting field removal or alias change refuses to overwrite', () => {
  const base = {providers: {'magpie:demo': {historyFilter: true}}, aliases: {}};
  const draft = M.change(base, 'demo', 'historyFilter', false);
  assert.throws(() => M.merge(base, draft, {providers: {}, aliases: {}}), /options_conflict/);
  assert.throws(() => M.merge(base, draft, {...base, aliases: {demo: 'backup'}}), /options_conflict/);
});

test('invalid saved rules cannot be silently replaced and special IDs are safe', () => {
  for (const options of [[], null, {providers: []}, {providers: {'magpie:demo': null}},
    {providers: {'magpie:demo': {historyFilter: 'true'}}}, {aliases: {demo: false}}]) {
    assert.throws(() => M.rows(options, list), /invalid_options/);
  }
  assert.throws(() => M.rows({}, [{id: 'demo/model', name: 'Invalid'}]), /invalid_providers/);
  const saved = M.change({}, '__proto__', 'historyFilter', true);
  const row = M.rows(saved, [{id: '__proto__', name: '<img onerror=bad()>'}])[0];
  assert.equal(row.target, '__proto__');
  assert.equal(row.on, true);
  assert.equal({}.historyFilter, undefined);
});

test('GUI-saved options drive the unchanged hook for the chosen provider only', () => {
  const base = {providers: {}, aliases: {}};
  const saved = M.merge(base, M.change(base, 'demo', 'historyFilter', true), base);
  const input = [{type: 'reasoning', encrypted_content: 'foreign'},
    {type: 'message', id: 'msg_foreign', role: 'user', content: 'hello'}];
  const context = {protocol: 'responses', path: '/v1/responses', options: saved,
    reject() { assert.fail('portable request should pass'); }};
  const result = onRequest({model: 'demo/model', include: ['reasoning.encrypted_content'], input}, context);
  assert.equal(result.input.length, 1);
  assert.equal(result.input[0].id, undefined);
  assert.deepEqual(result.include, ['reasoning.encrypted_content']);
  assert.equal(onRequest({model: 'backup/model', input}, context), undefined);
});
