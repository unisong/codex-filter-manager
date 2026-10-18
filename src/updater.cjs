'use strict';

// Shared verbatim with the self-contained Magpie package.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const REPOSITORY = 'unisong/codex-filter-manager';
const RELEASES = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
const versionParts = value => /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)?.slice(1).map(Number);
function newer(a, b) {
  const aa = versionParts(a), bb = versionParts(b);
  if (!aa || !bb) return false;
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i];
  return false;
}
function releaseURL(value, tag, name) {
  return value === `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`;
}
function selectReleases(data, current) {
  if (!Array.isArray(data)) throw Error('GitHub 返回的版本列表无效。');
  return data.filter(r => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name)
    && versionParts(r.tag_name) && newer(r.tag_name, current)).map(r => {
    const name = `codex-filter-manager-${r.tag_name}-windows.zip`;
    const zip = r.assets?.find(a => a.name === name && releaseURL(a.browser_download_url, r.tag_name, name));
    const sums = r.assets?.find(a => a.name === 'SHA256SUMS.txt' && releaseURL(a.browser_download_url, r.tag_name, a.name));
    if (!zip || !sums || !Number.isSafeInteger(zip.size) || zip.size <= 0 || zip.size > 128 * 1024 * 1024) return null;
    return {tag: r.tag_name, name, size: zip.size, url: zip.browser_download_url, sums: sums.browser_download_url,
      notes: String(r.body || '').slice(0, 12000), page: `https://github.com/${REPOSITORY}/releases/tag/${r.tag_name}`};
  }).filter(Boolean).sort((a, b) => newer(a.tag, b.tag) ? -1 : 1);
}
function checksum(text, name) {
  const entries = text.split(/\r?\n/).map(line => /^([a-f\d]{64})\s+\*?(.+)$/i.exec(line));
  const matches = entries.filter(entry => entry?.[2] === name);
  if (matches.length !== 1) throw Error('发布包缺少唯一的 SHA-256 校验值。');
  return matches[0][1].toLowerCase();
}
async function download(url, maxBytes, fetcher, {timeout = 30000, accept = 'application/octet-stream'} = {}) {
  const response = await fetcher(url, {headers: {'User-Agent': 'codex-filter-manager-updater', Accept: accept},
    signal: AbortSignal.timeout(timeout)});
  if (!response.ok) throw Error(response.status === 403 || response.status === 429
    ? 'GitHub 暂时限制请求，请稍后重试。' : `下载失败（HTTP ${response.status}），请稍后重试。`);
  if (Number(response.headers.get('content-length')) > maxBytes) throw Error('下载超过大小限制。');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw Error('下载超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function launch(script, plan) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Plan', plan], {detached: true, windowsHide: true, stdio: 'ignore'});
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
function createUpdater({root, directory, currentVersion, mode = 'ccswitch', helper, restart,
  fetcher = fetch, platform = process.platform, spawnHelper = launch, now = Date.now}) {
  let releases = [], checking = null, working = null;
  const resultFile = path.join(directory, 'update-result.json');
  let state = {currentVersion, checkedAt: null, phase: 'idle', error: null};
  function snapshot() {
    let result;
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
    if (result?.phase === 'installing' && now() - Date.parse(result.at || '') > 10 * 60000) {
      result = {...result, phase: 'failed', message: '更新超过十分钟仍未完成，请查看更新日志和服务状态后重试。'};
    }
    const supported = platform === 'win32';
    const sourceCheckout = fs.existsSync(path.join(root, '.git')) || (mode === 'magpie' && fs.existsSync(path.join(root, '..', '.git')));
    return {...state, mode, releases: releases.map(({tag, notes, size, page}) => ({tag, notes, size, page})),
      canInstall: supported && (mode === 'magpie' || !sourceCheckout),
      installLabel: mode === 'magpie' ? '下载并准备新版' : '安装并重启',
      installReason: !supported ? '一键安装仅支持 Windows；可从版本链接下载。'
        : mode === 'ccswitch' && sourceCheckout ? '当前是 Git 源码目录，为保护未提交修改，请通过 Git 更新。' : '',
      result: result && {phase: result.phase, message: result.message, target: result.target, tag: result.tag}};
  }
  async function check() {
    if (working) throw Error('正在准备更新，请稍后再检查。');
    if (checking) return checking;
    checking = (async () => {
      state = {...state, phase: 'checking', error: null};
      try {
        const raw = await download(RELEASES, 4 * 1024 * 1024, fetcher, {accept: 'application/vnd.github+json'});
        releases = selectReleases(JSON.parse(raw.toString('utf8')), currentVersion);
        state = {...state, phase: 'idle', checkedAt: new Date(now()).toISOString()};
      } catch (error) {
        releases = []; state = {...state, phase: 'idle', error: error.message === 'The operation was aborted due to timeout'
          ? '连接 GitHub 超时，请重试。' : '检查更新失败：' + error.message};
      }
      return snapshot();
    })().finally(() => { checking = null; });
    return checking;
  }
  function install(tag) {
    if (working || checking || snapshot().result?.phase === 'installing') throw Error('已有更新操作正在进行。');
    if (!snapshot().canInstall) throw Error(snapshot().installReason);
    const release = releases.find(r => r.tag === tag);
    if (!release || !state.checkedAt || now() - Date.parse(state.checkedAt) > 3600000) throw Error('请先重新检查更新，再选择列表中的版本。');
    state = {...state, phase: 'downloading', error: null};
    working = (async () => {
      const job = path.join(directory, 'updates', randomUUID());
      try {
        fs.mkdirSync(job, {recursive: true});
        const sums = await download(release.sums, 65536, fetcher);
        const expected = checksum(sums.toString('utf8'), release.name);
        const archive = await download(release.url, 128 * 1024 * 1024, fetcher, {timeout: 180000});
        if (archive.length !== release.size || createHash('sha256').update(archive).digest('hex') !== expected) throw Error('发布包 SHA-256 或大小校验失败，未安装。');
        const archivePath = path.join(job, release.name);
        fs.writeFileSync(archivePath, archive, {flag: 'wx'});
        const runner = path.join(job, 'install-update.ps1');
        fs.copyFileSync(helper, runner);
        const plan = {root: path.resolve(root), job, mode, tag, archive: archivePath, sha256: expected,
          resultFile, restart, node: process.execPath};
        const planFile = path.join(job, 'plan.json');
        fs.writeFileSync(planFile, JSON.stringify(plan), {mode: 0o600, flag: 'wx'});
        fs.writeFileSync(resultFile, JSON.stringify({phase: 'installing', tag, at: new Date(now()).toISOString(), message: '正在校验文件并准备更新…'}));
        await spawnHelper(runner, planFile);
        state = {...state, phase: 'idle'};
      } catch (error) {
        state = {...state, phase: 'idle', error: '更新失败：' + error.message};
        try { fs.writeFileSync(resultFile, JSON.stringify({phase: 'failed', tag, message: state.error})); } catch {}
      }
    })().finally(() => { working = null; });
    return snapshot();
  }
  return {snapshot, check, install, get busy() { return !!working || snapshot().result?.phase === 'installing'; },
    // Useful to wait for the bounded download when shutting down or in offline tests.
    settle: () => working || Promise.resolve()};
}
module.exports = {createUpdater, selectReleases, checksum, newer};
