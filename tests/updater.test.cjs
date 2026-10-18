'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {createUpdater, selectReleases, checksum, newer, compareVersions, normalizeDownloadDirectory} = require('../src/updater.cjs');
const archive = Buffer.from('offline archive fixture');
const digest = createHash('sha256').update(archive).digest('hex');
function release(tag = 'v1.2.0', extra = {}) {
  const name = `codex-filter-manager-${tag}-windows.zip`;
  const asset = (name, size) => ({name, size, browser_download_url: `https://github.com/unisong/codex-filter-manager/releases/download/${tag}/${name}`});
  return {tag_name: tag, body: 'Offline release notes', assets: [asset(name, archive.length), asset('SHA256SUMS.txt', 100)], ...extra};
}
function setup(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-updater-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, {recursive: true, force: true}); });
  const directory = path.join(root, '.runtime'); fs.mkdirSync(directory);
  const helper = path.join(root, 'helper.ps1'); fs.writeFileSync(helper, '# offline');
  const calls = [], spawned = [];
  const fetcher = async url => {
    calls.push(url);
    return new Response(url.includes('api.github.com') ? JSON.stringify([release()])
      : url.endsWith('SHA256SUMS.txt') ? `${digest}  codex-filter-manager-v1.2.0-windows.zip\n` : archive);
  };
  const updater = createUpdater({root, directory, currentVersion: '1.0.9', platform: 'win32', helper, fetcher,
    restart: ['--config', 'a path with spaces'], spawnHelper: async (...args) => spawned.push(args), ...extra});
  return {root, directory, updater, calls, spawned};
}
test('only newer stable releases with official complete assets are selectable', () => {
  const evil = release('v1.5.0'); evil.assets[0].browser_download_url = 'https://evil.example/payload.zip';
  assert.deepEqual(selectReleases([release('v1.0.9'), release('v1.1.0'), release('v1.3.0'), release('v1.2.0'), release('v1.10.0'),
    release('v9.0.0', {draft: true}), release('v9.0.0', {prerelease: true}), evil,
    release('v2.0.0', {assets: []}), release('v2.0.0;command')], '1.0.9').map(r => r.tag), ['v1.10.0', 'v1.3.0', 'v1.2.0', 'v1.1.0']);
  assert.equal(newer('v1.10.0', '1.9.0'), true); assert.equal(newer('v01.2.3', '1.0.0'), false);
  assert.ok(compareVersions('v1.10.0', 'v1.9.9') > 0);
  assert.throws(() => checksum(`${digest} file.zip\n${digest} file.zip`, 'file.zip'), /唯一/);
});
test('download progress exposes byte counts and percentage before the installer starts', async t => {
  let continueDownload, firstChunk;
  const started = new Promise(resolve => { firstChunk = resolve; });
  const remaining = new Promise(resolve => { continueDownload = resolve; });
  const f = setup(t, {fetcher: async url => {
    if (url.includes('api.github.com')) return new Response(JSON.stringify([release()]));
    if (url.endsWith('SHA256SUMS.txt')) return new Response(`${digest}  codex-filter-manager-v1.2.0-windows.zip\n`);
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(archive.subarray(0, 9));
        firstChunk();
        await remaining;
        controller.enqueue(archive.subarray(9)); controller.close();
      }
    });
    return new Response(body, {headers: {'content-length': String(archive.length)}});
  }});
  await f.updater.check();
  f.updater.install('v1.2.0');
  await started;
  await new Promise(resolve => setImmediate(resolve));
  const live = f.updater.snapshot();
  assert.equal(live.phase, 'downloading');
  assert.equal(live.progress.kind, 'archive');
  assert.equal(live.progress.total, archive.length);
  assert.ok(live.progress.received > 0 && live.progress.received < archive.length);
  assert.ok(live.progress.percent > 0 && live.progress.percent < 100);
  continueDownload();
  await f.updater.settle();
  assert.equal(f.spawned.length, 1);
  assert.equal(f.updater.snapshot().result.phase, 'installing');
});
test('reading update state is offline; verified download creates a structured plan without shell interpolation', async t => {
  const f = setup(t); f.updater.snapshot(); assert.equal(f.calls.length, 0);
  assert.throws(() => f.updater.install('v1.2.0'), /检查/);
  await f.updater.check(); assert.equal(f.updater.snapshot().releases.length, 1);
  f.updater.install('v1.2.0'); assert.throws(() => f.updater.install('v1.2.0'), /正在进行/);
  await f.updater.settle(); assert.equal(f.spawned.length, 1);
  const plan = JSON.parse(fs.readFileSync(f.spawned[0][1]));
  assert.deepEqual(plan.restart, ['--config', 'a path with spaces']); assert.equal(plan.sha256, digest);
  assert.equal(fs.readFileSync(plan.archive).toString(), archive.toString());
  assert.equal(f.updater.snapshot().result.phase, 'installing');
});
test('custom download directory is writable, persistent and used for update jobs', async t => {
  const f = setup(t), custom = path.join(f.root, 'custom updates');
  assert.equal(f.updater.snapshot().downloadDirectory, path.join(f.directory, 'updates'));
  assert.throws(() => normalizeDownloadDirectory('relative/path'), /绝对路径/);
  assert.throws(() => normalizeDownloadDirectory(path.parse(f.root).root), /磁盘根目录/);
  const configured = f.updater.configureDownloadDirectory(`"${custom}"`);
  assert.equal(configured.downloadDirectoryCustom, true);
  assert.equal(configured.downloadDirectory, custom);
  f.updater.configureDownloadDirectory(custom);
  const marker = path.join(custom, 'keep.txt'); fs.writeFileSync(marker, 'keep');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'update-settings.json'), 'utf8')).downloadDirectory, custom);
  const helper = path.join(f.root, 'helper.ps1');
  const reopened = createUpdater({root: f.root, directory: f.directory, currentVersion: '1.0.9', platform: 'win32',
    helper, spawnHelper: async () => {}});
  assert.equal(reopened.snapshot().downloadDirectory, custom);
  const restored = reopened.configureDownloadDirectory(null);
  assert.equal(restored.downloadDirectoryCustom, false);
  assert.equal(restored.downloadDirectory, path.join(f.directory, 'updates'));
  assert.equal(fs.existsSync(path.join(f.directory, 'update-settings.json')), false);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  await f.updater.check(); f.updater.install('v1.2.0'); await f.updater.settle();
  const plan = JSON.parse(fs.readFileSync(f.spawned[0][1], 'utf8'));
  assert.equal(path.dirname(plan.job), custom);
  assert.equal(fs.existsSync(plan.archive), true);
});
test('stale or misplaced completion notices are not presented as current success', t => {
  let now = Date.parse('2026-10-18T12:00:00Z');
  const f = setup(t, {now: () => now}), resultFile = path.join(f.directory, 'update-result.json');
  fs.writeFileSync(resultFile, JSON.stringify({phase: 'ready', tag: 'v1.2.0', target: path.join(f.root, 'missing'),
    at: new Date(now).toISOString()}));
  assert.equal(f.updater.snapshot().result, null);
  const target = path.join(f.root, 'prepared'); fs.mkdirSync(target);
  fs.writeFileSync(resultFile, JSON.stringify({phase: 'ready', tag: 'v1.2.0', target,
    at: new Date(now).toISOString()}));
  assert.equal(f.updater.snapshot().result.phase, 'ready');
  fs.writeFileSync(resultFile, JSON.stringify({phase: 'failed', tag: 'v1.2.0', message: 'legacy result without timestamp'}));
  assert.equal(f.updater.snapshot().result, null);
  fs.writeFileSync(resultFile, JSON.stringify({phase: 'ready', tag: 'v1.2.0', target,
    at: new Date(now).toISOString()}));
  now += 25 * 60 * 60 * 1000;
  assert.equal(f.updater.snapshot().result, null);
});
test('checksum mismatch never launches an installer', async t => {
  const f = setup(t, {fetcher: async url => new Response(url.includes('api.github.com') ? JSON.stringify([release()])
    : url.endsWith('SHA256SUMS.txt') ? `${'0'.repeat(64)}  codex-filter-manager-v1.2.0-windows.zip` : archive)});
  await f.updater.check(); f.updater.install('v1.2.0'); await f.updater.settle();
  assert.equal(f.spawned.length, 0); assert.match(f.updater.snapshot().error, /SHA-256/);
});
test('GitHub metadata requests use JSON while release asset downloads retain binary Accept', async t => {
  const requests = [];
  const f = setup(t, {fetcher: async (url, options) => {
    requests.push({url, accept: options.headers.Accept});
    if (url.includes('api.github.com')) {
      if (options.headers.Accept !== 'application/vnd.github+json') return new Response('Unsupported Accept header', {status: 415});
      return new Response(JSON.stringify([release()]));
    }
    if (options.headers.Accept !== 'application/octet-stream') return new Response('Expected asset request', {status: 415});
    return new Response(url.endsWith('SHA256SUMS.txt') ? `${digest}  codex-filter-manager-v1.2.0-windows.zip\n` : archive);
  }});
  const result = await f.updater.check();
  assert.equal(result.error, null);
  assert.equal(result.releases.length, 1);
  f.updater.install('v1.2.0'); await f.updater.settle();
  assert.equal(f.spawned.length, 1);
  assert.deepEqual(requests.map(r => r.accept), ['application/vnd.github+json', 'application/octet-stream', 'application/octet-stream']);
});
test('network and rate-limit failures retain the running installation', async t => {
  const f = setup(t, {fetcher: async () => new Response('', {status: 429})});
  const result = await f.updater.check(); assert.match(result.error, /限制请求/);
  assert.equal(result.releases.length, 0); assert.equal(f.spawned.length, 0);
});
test('unwritable staging reports failure without an unhandled rejection or installer', async t => {
  const f = setup(t); await f.updater.check();
  fs.writeFileSync(path.join(f.directory, 'updates'), 'blocks directory creation');
  f.updater.install('v1.2.0'); await f.updater.settle();
  assert.equal(f.spawned.length, 0); assert.match(f.updater.snapshot().error, /更新失败/);
});
test('source checkouts and non-Windows installs refuse replacement; Magpie stages only', async t => {
  const f = setup(t); fs.mkdirSync(path.join(f.root, '.git')); await f.updater.check();
  assert.throws(() => f.updater.install('v1.2.0'), /Git/);
  const unsupported = setup(t, {platform: 'linux'}); assert.equal(unsupported.updater.snapshot().canInstall, false);
  const magpie = setup(t, {mode: 'magpie'}); fs.mkdirSync(path.join(magpie.root, '.git'));
  await magpie.updater.check(); magpie.updater.install('v1.2.0'); await magpie.updater.settle();
  assert.equal(JSON.parse(fs.readFileSync(magpie.spawned[0][1])).mode, 'magpie');
});
