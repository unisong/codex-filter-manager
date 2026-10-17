'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {randomBytes, createHmac} = require('node:crypto');

const EVENTS = new Set(['starting', 'startup-error', 'listening', 'stopping', 'stopped', 'config-state', 'config-attached', 'config-error',
  'restore-failed', 'provider-rule-updated', 'legacy-aliases-updated', 'request-received', 'request-policy',
  'filtered', 'blocked', 'upstream-response', 'upstream-error', 'upstream-http-error', 'upstream-stream-error',
  'request-finished', 'request-disconnected', 'lite-header-stripped', 'model-alias-normalized',
  'retry-429', 'retry-429-exhausted', 'retry-429-permanent', 'guard-configured', 'guard-blocked',
  'guard-cleared', 'guard-passed', 'guard-manual-check-finished']);
const NUMBERS = ['removed', 'removedItemIds', 'removedEncryptedContentItems', 'status', 'durationMs',
  'attempt', 'attempts', 'delayMs', 'elapsedMs', 'budgetMs', 'rounds'];
const REASONS = new Set(['user-override', 'not-configured', 'unidentified-provider', 'policy-unavailable',
  'auto-failover', 'auto-failover-enabled', 'multiple-current-providers', 'base-url-unidentified',
  'complex-toml-unidentified', 'magpie-route-unverified', 'magpie-plugin-disabled', 'no-request-yet',
  'database-missing', 'auto-failover-or-unknown', 'current-provider-unidentified', 'database-or-config-unreadable']);
const STATES = new Set(['filtering', 'magpie-plugin', 'waiting-for-codex-config', 'waiting-for-supported-provider',
  'waiting-for-ccswitch', 'waiting-for-magpie', 'waiting-for-magpie-direct', 'config-error', 'stopping', 'stopped',
  'unresponsive', 'stale-state']);
const CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'timeout', 'filter_error',
  'EACCES', 'EPERM', 'ENOSPC', 'EADDRINUSE', 'ENOENT', 'EEXIST',
  'local_filter_error', 'invalid_request_json', 'invalid_compressed_request', 'invalid_input', 'invalid_include',
  'request_too_large', 'unsupported_content_encoding', 'response_reference_not_portable',
  'encrypted_context_not_portable', 'encrypted_compaction_disabled', 'proxy_loop', 'guard_unverified',
  'guard_upstream_error', 'guard_blocked', 'guard_model_mismatch', 'upstream_quota', 'upstream_rate_limit']);
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value));
const safeState = value => STATES.has(value) ? value : 'unknown';

// Only named metadata can leave the process. Error messages, URLs and payloads
// are deliberately excluded even if a future caller passes them to the logger.
function safeEvent(event, data = {}) {
  if (!EVENTS.has(event)) return null;
  const result = {time: iso(data.time) ? data.time : new Date().toISOString(), event};
  if (typeof data.requestId === 'string' && /^[a-f0-9-]{36}$/.test(data.requestId)) result.requestId = data.requestId;
  if (typeof data.providerToken === 'string' && /^p-[a-f0-9]{12}$/.test(data.providerToken)) result.providerToken = data.providerToken;
  for (const key of NUMBERS) if (Number.isSafeInteger(data[key]) && data[key] >= 0) result[key] = data[key];
  for (const key of ['filter', 'reset', 'enabled']) if (typeof data[key] === 'boolean') result[key] = data[key];
  if (data.reason !== undefined) result.reason = REASONS.has(data.reason) ? data.reason : 'other';
  if (data.state !== undefined) result.state = safeState(data.state);
  if (data.code !== undefined) result.code = CODES.has(data.code) ? data.code : 'other';
  return result;
}

function createDiagnostics({runtime, maxBytes = 1024 * 1024, files = 5, retentionMs = 7 * 86400000, now = Date.now} = {}) {
  const filename = path.join(runtime, 'diagnostics.jsonl'), salt = randomBytes(32);
  const counters = {}, recent = [];
  let writeFailures = 0, lastRequestAt = null, lastRequestId = null, lastDecision = null, pruneDay = null;
  function prune() {
    const day = Math.floor(now() / 86400000);
    if (pruneDay === day) return;
    for (let i = 0; i < files; i++) {
      const file = filename + (i ? '.' + i : '');
      try {
        const stat = fs.statSync(file);
        if (now() - stat.mtimeMs > retentionMs) { fs.unlinkSync(file); continue; }
        if (stat.size <= maxBytes) {
          const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
          const kept = lines.filter(line => {
            try { const row = JSON.parse(line); return iso(row.time) && now() - Date.parse(row.time) <= retentionMs; } catch { return false; }
          });
          if (kept.length !== lines.length) fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '', {mode: 0o600});
        }
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    pruneDay = day;
  }
  function record(event, data = {}) {
    const row = safeEvent(event, {...data, time: new Date(now()).toISOString()});
    if (!row) return;
    const provider = data.providerId || data.provider;
    if (typeof provider === 'string') row.providerToken = 'p-' + createHmac('sha256', salt).update(provider).digest('hex').slice(0, 12);
    counters[event] = (counters[event] || 0) + 1;
    if (event === 'request-received') { lastRequestAt = row.time; lastRequestId = row.requestId; lastDecision = null; }
    if (row.requestId === lastRequestId && ['request-policy', 'filtered', 'blocked'].includes(event)) lastDecision = row;
    recent.push(row); if (recent.length > 200) recent.shift();
    try {
      fs.mkdirSync(runtime, {recursive: true});
      prune();
      const line = JSON.stringify(row) + '\n';
      if (fs.existsSync(filename) && fs.statSync(filename).size + Buffer.byteLength(line) > maxBytes) {
        for (let i = files - 1; i >= 1; i--) {
          const target = filename + '.' + i, source = filename + (i > 1 ? '.' + (i - 1) : '');
          if (fs.existsSync(target)) fs.unlinkSync(target);
          if (fs.existsSync(source)) fs.renameSync(source, target);
        }
      }
      fs.appendFileSync(filename, line, {mode: 0o600});
    } catch { writeFailures++; } // Diagnostics must not break a model request.
  }
  function history() {
    const rows = [];
    for (let i = files - 1; i >= 0; i--) {
      try {
        const file = filename + (i ? '.' + i : ''), stat = fs.statSync(file);
        if (stat.size > maxBytes || now() - stat.mtimeMs > retentionMs) continue;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          try {
            const value = JSON.parse(line), row = safeEvent(value.event, value);
            if (row && iso(value.time) && now() - Date.parse(row.time) <= retentionMs) rows.push(row);
          } catch {}
        }
      } catch {}
    }
    return rows.slice(-200);
  }
  return {record, snapshot: () => ({counters: {...counters}, lastRequestAt, lastDecision, writeFailures,
    observation: recent.length ? 'current-process' : 'retained-file-events',
    events: recent.length ? recent.filter(row => now() - Date.parse(row.time) <= retentionMs) : history(), retention: {days: retentionMs / 86400000, maxBytes: maxBytes * files}})};
}

function reachable(origin) {
  return new Promise(resolve => {
    let url;
    try {
      url = new URL(origin);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) return resolve(null);
    } catch { return resolve(null); }
    const socket = net.connect({host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80)});
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1200, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  });
}

async function buildReport({service = {}, management, recorder, gatewayReachable, configMatches, requestObservationAvailable = true, now = Date.now()} = {}) {
  const report = {schemaVersion: 1, generatedAt: new Date(now).toISOString(), product: 'codex-filter-manager',
    version: require('../package.json').version, runtime: {node: process.versions.node, platform: process.platform},
    service: {running: service.running === true, state: safeState(service.state),
      backend: service.backend === 'magpie' ? 'magpie' : service.backend === 'ccswitch' ? 'ccswitch' : 'unknown',
      filterVersion: Number.isInteger(service.filterVersion) ? service.filterVersion : null},
    checks: [], privacy: 'Metadata only. No prompts, credentials, provider names, URLs or local paths. No upload.',
    feedbackUrl: 'https://github.com/unisong/codex-filter-manager/issues/new?template=bug_report.yml'};
  const check = (code, level, message) => report.checks.push({code, level, message});
  let state;
  try { state = management?.state(); }
  catch { check('settings-unreadable', 'error', '无法读取供应商或过滤规则。请检查文件格式与权限；报告不包含原文件。'); }
  const log = recorder?.snapshot() || {counters: {}, events: []};
  report.diagnostics = log;
  if (!report.service.running) check('service-unavailable', 'error', '管理服务未运行或无响应。CC Switch 用户先启动服务；Magpie 用户请使用工作台自带的诊断入口。');
  else check('service-ready', 'info', '管理服务可响应。此项不代表模型请求已经接入或完成过滤。');
  if (service.state === 'config-error') check('config-error', 'error', '配置接入失败。请检查配置格式和恢复信息；不要删除恢复备份。');
  if (report.service.backend === 'magpie') check('use-magpie-workbench', 'warning', 'Magpie 不再使用独立管理服务，请加载 magpie-workbench 完整插件并使用其诊断入口。');
  if (configMatches === false || (service.running && !['filtering', 'config-error'].includes(service.state))) {
    check('config-not-attached', 'warning', '配置未确认接入过滤端口。检查实际配置；地址更改后可能需要完全重启 Codex。');
  }
  if (gatewayReachable === false) check('gateway-unreachable', 'error', '本地网关端口无法连接。请启动 CC Switch；此项不是供应商模型质量结论。');
  report.gatewayReachable = typeof gatewayReachable === 'boolean' ? gatewayReachable : null;
  if (state) {
    report.rules = {total: state.providers.length, enabled: state.providers.filter(p => p.rule?.historyFilter).length,
      autoFailover: state.autoFailover === true};
    if (state.autoFailover) check('auto-failover', 'warning', 'CC Switch 自动故障转移已开启，本工具不能固定识别上游，历史过滤暂不执行。');
    if (!report.rules.enabled) check('no-enabled-rules', 'warning', '所有供应商历史过滤均关闭，当前直通属于预期行为。');
  }
  if (service.running && !requestObservationAvailable) check('live-diagnostics-unavailable', 'warning', '当前服务未提供实时诊断，运行计数不可用。请升级服务或检查管理接口；文件事件可能来自上次运行。');
  if (service.running && requestObservationAvailable) {
    if (!log.lastRequestAt) check('no-requests', 'warning', '本次启动后尚未收到 Responses 请求。发一条消息后重新检查；可能使用旧连接配置、其他入口或尚未发送请求，不能据此断定忘记重启。');
    else {
      report.lastRequestAt = log.lastRequestAt;
      if (now - Date.parse(log.lastRequestAt) > 10 * 60000) check('old-request', 'warning', '最近一次请求已超过 10 分钟。复现后重新检查，旧计数不能证明当前窗口已经接入。');
      const decision = log.lastDecision;
      if (decision?.event === 'filtered') {
        const removed = (decision.removed || 0) + (decision.removedItemIds || 0) + (decision.removedEncryptedContentItems || 0);
        check(removed ? 'filtered' : 'clean-history', 'info', removed ? '最近一次完成了历史清理。请结合相同请求编号的后续响应判断是否另有上游错误。' : '最近一次已执行历史检查，没有需要清理的内容，属于正常情况。');
      } else if (decision?.event === 'blocked') check('request-blocked', 'error', '最近一次请求被本地明确拒绝。请在事件中查看错误类型；不可迁移的历史需文字摘要后新建会话。');
      else if (decision?.filter === false) {
        const reason = {'not-configured': '目标供应商尚未配置规则。', 'user-override': '目标供应商历史过滤开关已关闭。',
          'auto-failover-or-unknown': '自动故障转移已开启或状态无法识别。', 'policy-unavailable': '过滤规则读取失败。',
          'database-missing': '供应商数据库不存在。', 'database-or-config-unreadable': '供应商数据库或配置无法读取。',
          'current-provider-unidentified': '无法唯一识别当前供应商。'}[decision.reason] || '请查看事件中的规则原因，并核对目标供应商开关。';
        check('passthrough', 'warning', '最近一次请求原样转发：' + reason);
      }
    }
    if ((log.counters['upstream-http-error'] || 0) + (log.counters['upstream-error'] || 0) + (log.counters['upstream-stream-error'] || 0)) {
      check('upstream-errors-seen', 'warning', '本次运行出现过上游 HTTP、连接或流异常。请按发生时间和请求编号核对；清理历史不能修复余额、权限或服务不可用。');
    }
  }
  if (log.writeFailures) check('diagnostic-write-failed', 'warning', '部分诊断记录未能写入磁盘。请检查剩余空间和目录权限；过滤请求未因此被中断。');
  report.limits = ['不读取运行中 Codex 的实际生效配置，配置与重启提示仅为排查线索。',
    'HTTP 200 或完成转发不证明模型回答正确；不解析并保存完整响应，SSE 内部业务错误未必可识别。',
    'Magpie 插件的规则命中、清理数量、超时放行需宿主提供诊断接口；此报告不会虚构这些指标。'];
  return report;
}

module.exports = {createDiagnostics, buildReport, reachable, safeEvent};
