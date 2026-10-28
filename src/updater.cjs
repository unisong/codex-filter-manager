'use strict';

// Shared verbatim with the self-contained Magpie package.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const REPOSITORY = 'unisong/codex-filter-manager';
const RELEASES = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
const versionParts = value => /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)?.slice(1).map(Number);
function compareVersions(a, b) {
  const aa = versionParts(a), bb = versionParts(b);
  if (!aa || !bb) return 0;
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
}
function newer(a, b) {
  return compareVersions(a, b) > 0;
}
const newestFirst = (a, b) => compareVersions(b.tag, a.tag);
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
  }).filter(Boolean).sort(newestFirst);
}
function checksum(text, name) {
  const entries = text.split(/\r?\n/).map(line => /^([a-f\d]{64})\s+\*?(.+)$/i.exec(line));
  const matches = entries.filter(entry => entry?.[2] === name);
  if (matches.length !== 1) throw Error('发布包缺少唯一的 SHA-256 校验值。');
  return matches[0][1].toLowerCase();
}
function normalizeDownloadDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw Error('请输入更新下载与暂存目录的绝对路径。');
  const unquoted = value.trim().replace(/^"(.*)"$/, '$1');
  if (unquoted.includes('\0') || !path.isAbsolute(unquoted)) throw Error('更新下载与暂存目录必须是绝对路径。');
  const resolved = path.resolve(unquoted);
  if (resolved === path.parse(resolved).root) throw Error('不能直接使用磁盘根目录，请选择其中一个文件夹。');
  return resolved;
}
function prepareDownloadDirectory(value) {
  const resolved = normalizeDownloadDirectory(value);
  fs.mkdirSync(resolved, {recursive: true});
  if (!fs.statSync(resolved).isDirectory()) throw Error('所选更新下载与暂存位置不是文件夹。');
  const probe = path.join(resolved, '.codex-filter-write-' + randomUUID());
  try { fs.writeFileSync(probe, '', {flag: 'wx', mode: 0o600}); }
  catch { throw Error('所选更新下载与暂存目录不可写，请更换目录。'); }
  finally { try { fs.unlinkSync(probe); } catch {} }
  return resolved;
}
async function download(url, maxBytes, fetcher, {timeout = 30000, accept = 'application/octet-stream', onProgress} = {}) {
  const response = await fetcher(url, {headers: {'User-Agent': 'codex-filter-manager-updater', Accept: accept},
    signal: AbortSignal.timeout(timeout)});
  if (!response.ok) throw Error(response.status === 403 || response.status === 429
    ? 'GitHub 暂时限制请求，请稍后重试。' : `下载失败（HTTP ${response.status}），请稍后重试。`);
  const announced = Number(response.headers.get('content-length'));
  const total = Number.isSafeInteger(announced) && announced > 0 ? announced : null;
  if (total > maxBytes) throw Error('下载超过大小限制。');
  const chunks = []; let size = 0;
  onProgress?.({received: 0, total});
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw Error('下载超过大小限制。');
    chunks.push(chunk);
    onProgress?.({received: size, total});
  }
  onProgress?.({received: size, total: total || size});
  return Buffer.concat(chunks);
}
function launch(script, plan) {
  return new Promise((resolve, reject) => {
    // Windows PowerShell can silently skip -File under DETACHED_PROCESS. Let a
    // short-lived PowerShell bootstrap launch the independent, hidden helper.
    // Paths travel through environment variables, never interpolated shell code.
    const bootstrap = `$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$helperScript = $env:CODEX_FILTER_UPDATE_SCRIPT
$helperPlan = $env:CODEX_FILTER_UPDATE_PLAN
if ($helperScript.Contains('"') -or $helperPlan.Contains('"')) { throw 'Invalid helper path.' }
$helperArgs = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$helperScript+'"'),'-Plan',('"'+$helperPlan+'"'))
$helperProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList $helperArgs -PassThru
Write-Output $helperProcess.Id`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
      env: {...process.env, CODEX_FILTER_UPDATE_SCRIPT: script, CODEX_FILTER_UPDATE_PLAN: plan}});
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-16384); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-16384); });
    child.once('error', reject);
    child.once('close', code => code === 0 && /^\d+$/.test(output.trim()) ? resolve()
      : reject(Error('无法启动更新助手，请检查 PowerShell 权限。' + (errors ? ' ' + errors.trim() : ''))));
  });
}
function createUpdater({root, directory, currentVersion, mode = 'ccswitch', helper, restart,
  fetcher = fetch, platform = process.platform, spawnHelper = launch, now = Date.now}) {
  let releases = [], checking = null, working = null;
  const resultFile = path.join(directory, 'update-result.json');
  const settingsFile = path.join(directory, 'update-settings.json');
  const defaultDownloadDirectory = path.join(directory, 'updates');
  let configuredDownloadDirectory = null;
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (saved?.version === 1 && typeof saved.downloadDirectory === 'string') {
      configuredDownloadDirectory = normalizeDownloadDirectory(saved.downloadDirectory);
    }
  } catch {}
  let state = {currentVersion, checkedAt: null, phase: 'idle', progress: null, error: null};
  const downloadDirectory = () => configuredDownloadDirectory || defaultDownloadDirectory;
  function snapshot() {
    let result;
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
    if (result?.phase === 'installing' && now() - Date.parse(result.at || '') > 10 * 60000) {
      result = {...result, phase: 'failed', message: '更新超过十分钟仍未完成，请查看更新日志和服务状态后重试。'};
    }
    const resultAt = Date.parse(result?.at || '');
    if (['installed', 'ready', 'failed'].includes(result?.phase)
        && (!Number.isFinite(resultAt) || now() - resultAt > 24 * 60 * 60 * 1000)) result = null;
    if (result?.phase === 'ready' && (!result.target || !fs.existsSync(result.target))) result = null;
    if (['installed', 'ready'].includes(result?.phase) && compareVersions(result.tag, currentVersion) < 0) result = null;
    const supported = platform === 'win32';
    const sourceCheckout = fs.existsSync(path.join(root, '.git')) || (mode === 'magpie' && fs.existsSync(path.join(root, '..', '.git')));
    return {...state, mode, downloadDirectory: downloadDirectory(), defaultDownloadDirectory,
      downloadDirectoryCustom: !!configuredDownloadDirectory,
      releases: [...releases].sort(newestFirst).map(({tag, notes, size, page}) => ({tag, notes, size, page})),
      canInstall: supported && (mode === 'magpie' || !sourceCheckout),
      installLabel: mode === 'magpie' ? '下载并准备新版' : '安装并重启',
      installReason: !supported ? '一键安装仅支持 Windows；可从版本链接下载。'
        : mode === 'ccswitch' && sourceCheckout ? '当前是 Git 源码目录，为保护未提交修改，请通过 Git 更新。' : '',
      result: result && {phase: result.phase, message: result.message, target: result.target, tag: result.tag, at: result.at}};
  }
  function configureDownloadDirectory(value) {
    if (working || checking || snapshot().result?.phase === 'installing') throw Error('更新操作进行中，暂不能修改下载目录。');
    if (value === null || value === '') {
      try { fs.unlinkSync(settingsFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      configuredDownloadDirectory = null;
      return snapshot();
    }
    const resolved = prepareDownloadDirectory(value);
    const temp = settingsFile + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify({version: 1, downloadDirectory: resolved}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      fs.renameSync(temp, settingsFile);
    } finally { try { fs.unlinkSync(temp); } catch {} }
    configuredDownloadDirectory = resolved;
    return snapshot();
  }
  async function check() {
    if (working) throw Error('正在准备更新，请稍后再检查。');
    if (checking) return checking;
    checking = (async () => {
      state = {...state, phase: 'checking', progress: {kind: 'metadata', received: 0, total: null, percent: null}, error: null};
      try {
        const raw = await download(RELEASES, 4 * 1024 * 1024, fetcher, {accept: 'application/vnd.github+json',
          onProgress: progress => { state = {...state, progress: {kind: 'metadata', ...progress, percent: null}}; }});
        releases = selectReleases(JSON.parse(raw.toString('utf8')), currentVersion);
        state = {...state, phase: 'idle', progress: null, checkedAt: new Date(now()).toISOString()};
      } catch (error) {
        releases = []; state = {...state, phase: 'idle', progress: null, error: error.message === 'The operation was aborted due to timeout'
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
    state = {...state, phase: 'downloading', progress: {kind: 'checksum', received: 0, total: null, percent: null}, error: null};
    working = (async () => {
      const job = path.join(downloadDirectory(), randomUUID());
      try {
        fs.mkdirSync(job, {recursive: true});
        const sums = await download(release.sums, 65536, fetcher);
        const expected = checksum(sums.toString('utf8'), release.name);
        const archive = await download(release.url, 128 * 1024 * 1024, fetcher, {timeout: 180000,
          onProgress: ({received, total}) => {
            const known = release.size || total;
            state = {...state, progress: {kind: 'archive', received, total: known,
              percent: known ? Math.min(100, Math.floor(received * 100 / known)) : null}};
          }});
        state = {...state, progress: {kind: 'verify', received: archive.length, total: archive.length, percent: 100}};
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
        state = {...state, phase: 'idle', progress: null};
      } catch (error) {
        state = {...state, phase: 'idle', progress: null, error: '更新失败：' + error.message};
        try { fs.writeFileSync(resultFile, JSON.stringify({phase: 'failed', tag, at: new Date(now()).toISOString(), message: state.error})); } catch {}
      }
    })().finally(() => { working = null; });
    return snapshot();
  }
  return {snapshot, check, install, configureDownloadDirectory,
    get busy() { return !!working || snapshot().result?.phase === 'installing'; },
    // Useful to wait for the bounded download when shutting down or in offline tests.
    settle: () => working || Promise.resolve()};
}
module.exports = {createUpdater, selectReleases, checksum, newer, compareVersions, normalizeDownloadDirectory};
