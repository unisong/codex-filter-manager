'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomBytes, randomUUID} = require('node:crypto');
const {analyzeSamples, validateEvidence} = require('./guard-evidence.cjs');
const {probeWithRetry} = require('./guard-retry.cjs');

const DEFAULT_POLICY = Object.freeze({enabled: false, ttlSeconds: 600});
const MAX_HISTORY = 100;
const TERMINAL_STATUSES = new Set(['passed', 'blocked', 'unverified', 'unsupported']);
const HISTORY_SOURCES = new Set(['automatic', 'manual', 'response', 'legacy']);
const TIMEOUT_MS = 600000;
const FAILURE_COOLDOWN_SECONDS = 60;
const ARTIFACT_ROOT = path.join(__dirname, '..', 'vendor', 'modeltrace');
const HASHES = {
  'challenge-browser.mjs': '4a3868c9fe237cabde92f0d2bffaf32118f558f7a43fcc336874fecd2bf6be39',
  'fingerprint-core.mjs': 'adff55637f6c0534c2c10703e028d4d1970d325e8daecb55efaa7f95a1938d5c',
  'unified_bank.json': 'eeab6ff54d6ffb2b294ebfd6cce25bce387f7a268b66759144f64c16f6c66b9f'
};

function failure(code, message) {
  const error = new Error(message);
  error.code = code; error.status = 409;
  return error;
}

function text(value, maximum = 512) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximum);
}

function identifier(value, label, maximum = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure('guard_invalid_setting', label + '格式无效。');
  }
  return value;
}

function validatePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['enabled', 'ttlSeconds'].includes(key))
      || typeof value.enabled !== 'boolean' || !Number.isInteger(value.ttlSeconds)
      || !(value.ttlSeconds === 0 || (value.ttlSeconds >= 60 && value.ttlSeconds <= 3600))) {
    throw failure('guard_invalid_setting', '检测设置无效：间隔须为 0（每次请求）或 60 到 3600 秒。');
  }
  return {enabled: value.enabled, ttlSeconds: value.ttlSeconds};
}

function atomicWrite(filename, value) {
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  const temporary = filename + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, value, {flag: 'wx', mode: 0o600});
    fs.renameSync(temporary, filename);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function artifacts() {
  const contents = {};
  for (const [name, expected] of Object.entries(HASHES)) {
    const bytes = fs.readFileSync(path.join(ARTIFACT_ROOT, name));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('fingerprint_checksum_mismatch');
    contents[name] = bytes;
  }
  const bank = JSON.parse(contents['unified_bank.json']);
  const {generateChallenges} = require(path.join(ARTIFACT_ROOT, 'challenge-browser.mjs'));
  return {bank, models: bank.models.map(model => model.id), generateChallenges};
}

function sameModel(expected, actual) {
  return typeof actual === 'string' && (actual === expected
    || (actual.startsWith(expected + '-') && /^\d{4}-\d{2}-\d{2}$/.test(actual.slice(expected.length + 1))));
}

// These are conservative classification thresholds from ModelTrace's MIT guard.
// The weights describe a closed reference set; they are never confidence claims.
function classify(result, expected) {
  if (!result || result.used_outputs !== 3 || !Array.isArray(result.results) || result.results.length < 2
      || (result.diagnostics && (result.diagnostics.length !== 3 || result.diagnostics.some(item => !item.accepted)))) {
    throw failure('guard_unverified', '三个检测样本未全部通过校验，不能判断模型一致性。');
  }
  const ordered = [...result.results].sort((a, b) => b.probability - a.probability);
  const top = ordered[0], candidate = ordered.find(item => item.model === expected);
  if (!candidate || ordered.some(item => typeof item.model !== 'string'
      || !Number.isFinite(item.probability) || item.probability < 0 || item.probability > 1)) {
    throw failure('guard_unverified', '指纹评分结果无效，未放行请求。');
  }
  const gap = top.probability - (top.model === expected ? ordered[1].probability : candidate.probability);
  let outcome = 'unverified';
  if (top.model === expected && top.probability >= 0.5) outcome = 'passed';
  else if (top.model !== expected && top.probability >= 0.8
      && candidate.probability <= 0.15 && gap >= 0.65) outcome = 'difference';
  return {outcome, prediction: top.model, score: top.probability, gap};
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(failure('guard_unverified', '请求已取消。'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(failure('guard_unverified', '请求已取消。')); };
    signal.addEventListener('abort', abort, {once: true});
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

function createGuard({runtime, probe, log = () => {}, onBlock = () => {}, now = Date.now, analyze} = {}) {
  if (typeof runtime !== 'string' || typeof probe !== 'function') throw new Error('Guard needs runtime and probe.');
  const filename = path.join(runtime, 'model-guard.json');
  const providers = new Map(), records = new Map(), blocks = new Map(), passes = new Map();
  // A failed check never authorizes a request. Reuse only its rejection for a
  // short period so client retries cannot start another paid probe batch.
  const cooldowns = new Map();
  // Completed attempts are immutable evidence, separate from current state and
  // the maps that authorize a request or retain a durable lock.
  const history = [];
  const flights = new Map(), generations = new Map(), keyGenerations = new Map(), admissions = new WeakMap();
  let closed = false;
  // Display why a historical pass cannot be reused without changing its verdict.
  // Trust remains exclusively in the live passes map and is never restored here.
  const cacheReasons = new Map();
  let fatal, bank, generateChallenges, models = [];
  try { ({bank, models, generateChallenges} = artifacts()); }
  catch { fatal = '指纹库缺失或校验失败。请修复本地安装后重启服务。'; }
  const iso = timestamp => new Date(timestamp).toISOString();
  const generation = id => generations.get(id) || 0;
  const keyGeneration = key => keyGenerations.get(key) || 0;
  const checkHealthy = () => { if (fatal) throw failure('guard_unverified', fatal); };
  const safeContext = context => ({key: identifier(context?.key, '路由标识', 1024),
    providerId: identifier(context?.providerId, '供应商 ID', 256),
    providerName: text(context?.providerName || context?.providerId, 256),
    model: identifier(context?.model, '模型名', 256), effort: text(context?.effort || 'default', 64)});
  const sanitizeRecord = record => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid_record');
    const clean = safeContext(record);
    if (!['unchecked', 'checking', 'suspect', 'passed', 'blocked', 'unverified', 'unsupported'].includes(record.status)) throw new Error('invalid_status');
    Object.assign(clean, {status: record.status, reason: text(record.reason), checkedAt: record.checkedAt || null,
      expiresAt: record.expiresAt || null, prediction: typeof record.prediction === 'string' ? text(record.prediction, 256) : null,
      score: Number.isFinite(record.score) ? record.score : null, gap: Number.isFinite(record.gap) ? record.gap : null,
      rounds: Number.isInteger(record.rounds) ? record.rounds : 0});
    if ([clean.checkedAt, clean.expiresAt].some(value => value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value))))) throw new Error('invalid_date');
    if (Object.hasOwn(record, 'retryAt')) {
      if (record.retryAt !== null && (typeof record.retryAt !== 'string' || !Number.isFinite(Date.parse(record.retryAt)))) throw new Error('invalid_retry_date');
      clean.retryAt = record.retryAt;
    }
    if (Object.hasOwn(record, 'sampleEvidence')) {
      if (!Array.isArray(record.sampleEvidence) || record.sampleEvidence.length > 2
          || !record.sampleEvidence.every(validateEvidence)) throw new Error('invalid_sample_evidence');
      clean.sampleEvidence = structuredClone(record.sampleEvidence);
    }
    return clean;
  };
  const sanitizeHistory = entry => {
    const clean = sanitizeRecord(entry);
    if (!TERMINAL_STATUSES.has(clean.status) || !HISTORY_SOURCES.has(entry.source)
        || typeof entry.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.id)
        || (entry.score !== null && entry.score !== undefined && (!Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1))
        || (entry.gap !== null && entry.gap !== undefined && (!Number.isFinite(entry.gap) || entry.gap < 0 || entry.gap > 1))
        || !Number.isInteger(entry.rounds) || entry.rounds < 0 || entry.rounds > 2) throw new Error('invalid_history');
    return Object.freeze({...clean, id: entry.id, source: entry.source});
  };
  try {
    const raw = fs.readFileSync(filename, 'utf8');
    const data = JSON.parse(raw);
    if (data.version !== 1 || !data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)
        || !Array.isArray(data.records) || data.records.length > MAX_HISTORY
        || !data.blocks || typeof data.blocks !== 'object' || Array.isArray(data.blocks)
        || (Object.hasOwn(data, 'history') && (!Array.isArray(data.history) || data.history.length > MAX_HISTORY))) throw new Error('invalid_guard_file');
    const legacyRecords = new Map();
    for (const [id, value] of Object.entries(data.providers)) providers.set(identifier(id, '供应商 ID', 256), validatePolicy(value));
    for (const value of data.records) {
      const record = sanitizeRecord(value);
      if (TERMINAL_STATUSES.has(record.status)) legacyRecords.set(record.key, {...record});
      if (record.status === 'passed') cacheReasons.set(record.key, '服务已重启，下次请求需要重新检测。');
      if (['checking', 'suspect'].includes(record.status)) Object.assign(record,
        {status: 'unchecked', reason: '服务已重启，下次请求需要重新检测。', expiresAt: null});
      records.set(record.key, record);
      // Only explicit failed checks have a retry deadline. Cancellations and
      // legacy records must not acquire a new cooldown merely on restart.
      if (['unverified', 'unsupported'].includes(record.status) && record.retryAt) {
        const until = Math.min(Date.parse(record.retryAt), now() + FAILURE_COOLDOWN_SECONDS * 1000);
        if (until > now()) cooldowns.set(record.key, {providerId: record.providerId, generation: 0, until,
          code: record.status === 'unsupported' ? 'guard_unsupported' : 'guard_unverified', reason: record.reason});
      }
    }
    for (const [key, value] of Object.entries(data.blocks)) {
      const record = sanitizeRecord(value);
      if (key !== record.key || record.status !== 'blocked') throw new Error('invalid_block');
      legacyRecords.set(key, {...record});
      blocks.set(key, record); records.set(key, record);
    }
    if (Object.hasOwn(data, 'history')) {
      const ids = new Set();
      for (const value of data.history) {
        const entry = sanitizeHistory(value);
        if (ids.has(entry.id)) throw new Error('duplicate_history_id');
        ids.add(entry.id); history.push(entry);
      }
    } else {
      for (const record of [...legacyRecords.values()]
        .sort((a, b) => String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''))).slice(0, MAX_HISTORY)) {
        history.push(sanitizeHistory({...record, id: randomUUID(), source: 'legacy'}));
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') fatal = '本地检测设置或锁定记录损坏。为避免失去保护，已暂停转发；请从 model-guard.json.previous 恢复后重启服务。';
  }

  function persist() {
    checkHealthy();
    try {
      const data = {version: 1, providers: Object.fromEntries(providers),
        records: [...records.values()].sort((a, b) => String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''))).slice(0, MAX_HISTORY),
        blocks: Object.fromEntries(blocks), history};
      if (fs.existsSync(filename)) atomicWrite(filename + '.previous', fs.readFileSync(filename, 'utf8'));
      atomicWrite(filename, JSON.stringify(data, null, 2) + '\n');
    } catch {
      fatal = '检测设置或锁定记录无法保存，已暂停转发。请检查本地文件权限和磁盘空间。';
      throw failure('guard_unverified', fatal);
    }
  }

  function makeRecord(context, details) {
    return {...safeContext(context), status: 'unchecked', reason: '', checkedAt: iso(now()), expiresAt: null,
      prediction: null, score: null, gap: null, rounds: 0, retryAt: null, ...details};
  }

  function rememberHistory(record, source) {
    history.unshift(sanitizeHistory({...record, id: randomUUID(), source}));
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  }

  function appendHistory(record, source) {
    rememberHistory(record, source); persist();
  }

  function activeCooldown(key) {
    const entry = cooldowns.get(key);
    if (entry && (entry.until <= now() || entry.generation !== generation(entry.providerId))) {
      cooldowns.delete(key); return null;
    }
    return entry || null;
  }

  function rememberFailure(context, code, reason) {
    const until = now() + FAILURE_COOLDOWN_SECONDS * 1000;
    cooldowns.set(context.key, {providerId: context.providerId, generation: generation(context.providerId),
      until, code, reason: text(reason)});
    return iso(until);
  }

  function rejectCooldown(entry) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.until - now()) / 1000));
    const error = failure(entry.code, '检测失败冷却中，' + retryAfterSeconds
      + ' 秒后可自动重试；也可在管理页手动重试。上次原因：' + entry.reason);
    error.retryAfterSeconds = retryAfterSeconds;
    error.retryAt = iso(entry.until);
    throw error;
  }

  function put(context, details) {
    const record = makeRecord(context, details);
    cacheReasons.delete(record.key);
    records.delete(record.key); records.set(record.key, record);
    // Preserve every durable latch separately; only non-blocked display history is evicted.
    while (records.size > MAX_HISTORY) {
      const removable = [...records.keys()].find(key => !blocks.has(key));
      if (!removable) break;
      records.delete(removable); cacheReasons.delete(removable); cooldowns.delete(removable);
    }
    persist(); return record;
  }

  function policy(providerId) {
    checkHealthy(); identifier(providerId, '供应商 ID', 256);
    return {...(providers.get(providerId) || DEFAULT_POLICY)};
  }

  function configure(providerId, value) {
    checkHealthy(); identifier(providerId, '供应商 ID', 256);
    const next = validatePolicy(value), previous = policy(providerId);
    if (next.enabled !== previous.enabled || next.ttlSeconds !== previous.ttlSeconds) {
      generations.set(providerId, generation(providerId) + 1);
      for (const [key, record] of passes) if (record.providerId === providerId) passes.delete(key);
      for (const [key, entry] of cooldowns) if (entry.providerId === providerId) cooldowns.delete(key);
      for (const entry of flights.values()) if (entry.context.providerId === providerId) entry.controller.abort();
      for (const [key, record] of records) if (record.providerId === providerId && !blocks.has(key)) {
        const reason = next.enabled ? '检测设置已更新，下次请求重新检测。' : '该供应商的检测已关闭。';
        if (record.status === 'passed') cacheReasons.set(key, reason);
        else records.set(key, {...record, status: 'unchecked', expiresAt: null, retryAt: null, reason});
      }
    }
    providers.set(providerId, next); persist();
    log('guard-configured', {providerId, ...next});
    return {...next};
  }

  function invalidate(providerId) {
    checkHealthy(); identifier(providerId, '供应商 ID', 256);
    generations.set(providerId, generation(providerId) + 1);
    for (const [key, record] of passes) if (record.providerId === providerId) passes.delete(key);
    for (const [key, entry] of cooldowns) if (entry.providerId === providerId) cooldowns.delete(key);
    for (const entry of flights.values()) if (entry.context.providerId === providerId) entry.controller.abort();
    for (const [key, record] of records) if (record.providerId === providerId && !blocks.has(key)) {
      const reason = '供应商路由已切换，下次请求需要重新检测。';
      if (record.status === 'passed') cacheReasons.set(key, reason);
      else records.set(key, {...record, status: 'unchecked', expiresAt: null, retryAt: null, reason});
    }
    persist();
  }

  function block(context, reason, actualModel, recordHistory = true) {
    checkHealthy(); const clean = safeContext(context), previous = records.get(clean.key);
    const alreadyBlocked = blocks.has(clean.key);
    passes.delete(clean.key);
    cooldowns.delete(clean.key);
    cacheReasons.delete(clean.key);
    const record = {...clean, status: 'blocked', reason: text(reason), checkedAt: iso(now()), expiresAt: null,
      prediction: typeof actualModel === 'string' ? text(actualModel, 256) : previous?.prediction || null,
      score: previous?.score ?? null, gap: previous?.gap ?? null, rounds: previous?.rounds || 0};
    if (!recordHistory && previous?.sampleEvidence) record.sampleEvidence = structuredClone(previous.sampleEvidence);
    blocks.set(clean.key, record); records.set(clean.key, record);
    // Probe runs append their single final result in run(). Only a business
    // response creates an independent event here, once per newly created lock.
    if (recordHistory && !alreadyBlocked) rememberHistory({...record, score: null, gap: null, rounds: 0}, 'response');
    let persistenceError;
    try { persist(); } catch (error) { persistenceError = error; }
    // Abort affected output even when disk failure prevents writing the latch.
    try { onBlock(context); } catch {}
    log('guard-blocked', {providerId: clean.providerId, model: clean.model, prediction: record.prediction});
    if (persistenceError) throw persistenceError;
    return {...record};
  }

  function assertAllowed(context) {
    checkHealthy(); safeContext(context);
    if (blocks.has(context.key)) throw failure('guard_blocked', blocks.get(context.key).reason);
    if (records.get(context.key)?.status === 'suspect') {
      throw failure('guard_unverified', '检测发现指纹差异信号，正在复核；本次输出已拦截。');
    }
    const admitted = admissions.get(context);
    if (admitted && (generation(context.providerId) !== admitted.generation
        || keyGeneration(context.key) !== admitted.keyGeneration || !policy(context.providerId).enabled)) {
      throw failure('guard_unverified', '检测设置在本次响应期间改变，输出已拦截；请重试。');
    }
  }

  function clear(key) {
    checkHealthy(); identifier(key, '路由标识', 1024);
    const previous = records.get(key) || blocks.get(key);
    blocks.delete(key); passes.delete(key); cooldowns.delete(key);
    keyGenerations.set(key, keyGeneration(key) + 1);
    if (flights.has(key)) flights.get(key).controller.abort();
    if (previous) put(previous, {status: 'unchecked', reason: '锁定已清除，下次请求仍须重新检测。'});
    else persist();
    log('guard-cleared', {key});
  }

  async function scoreRound(context, signal, progress, retryBudget) {
    const outputs = [];
    const scorer = require(path.join(ARTIFACT_ROOT, 'fingerprint-core.mjs'));
    // Use the same pinned challenge generator as ModelTrace's browser UI.
    // Keep each sample independent but sequential so a check occupies at most
    // one upstream slot and stops spending as soon as a sample is invalid.
    for (const [index, challenge] of generateChallenges(3).entries()) {
      if (signal.aborted) throw failure('guard_unverified', '检测已取消。');
      let output;
      try { output = await probeWithRetry({probe, context, signal, prompt: challenge.prompt, budget: retryBudget,
        onProgress: retry => progress(index + 1, retry)}); }
      catch (error) {
        if (error.code === 'guard_unverified') throw failure(error.code, '第 ' + (index + 1) + '/3 个样本：' + text(error.message));
        throw error;
      }
      if (signal.aborted) throw failure('guard_unverified', '检测已取消。');
      if (!sameModel(context.model, output?.model)) {
        block(context, '检测响应声明的模型与请求模型不一致，已锁定该模型。', output?.model, false);
        throw failure('guard_blocked', '检测响应声明的模型与请求模型不一致，已锁定该模型。');
      }
      if (typeof output.text !== 'string' || output.text.length > 65536) throw failure('guard_unverified', '检测没有返回有效的数字样本。');
      const count = scorer.parseNumbers(output.text).length;
      const minimum = Math.max(80, Math.ceil(challenge.expected_count * 0.55));
      if (count < minimum || count > challenge.expected_count * 2) {
        const diagnosis = count === 0 ? (output.text.trim()
          ? '正文不含可识别的 1–355 阿拉伯数字（提取到 ' + output.text.length + ' 个字符）。'
          : '未提取到非空正文。') : '';
        throw failure('guard_unverified', '第 ' + (index + 1) + '/3 个样本数字不足或异常：要求 '
          + challenge.expected_count + ' 个，收到 ' + count + ' 个有效数字，至少需要 ' + minimum
          + ' 个。' + diagnosis + '本轮检测不通过，未完成指纹评分；样本无效本身不能证明模型降智。');
      }
      outputs.push({text: output.text, expected_count: challenge.expected_count});
    }
    // The injected analyzer is a trusted test seam. Production always checks
    // each sample as well as the aggregate; an average can hide a mixed route.
    if (analyze) return classify(await analyze(outputs, bank), context.model);
    const {result, evidence} = analyzeSamples(outputs, bank, context.model);
    const verdict = classify(result, context.model);
    if (evidence.flags.repeatedSamples) return {...verdict, outcome: 'unverified', evidence,
      reason: '不同题目返回了完全重复的数字样本，不能视为三份独立证据，未能验证模型一致性。'};
    if (verdict.outcome !== 'difference' && evidence.flags.conflictingSamples) return {...verdict,
      outcome: 'unverified', evidence,
      reason: '单个样本强烈指向其他模型，存在样本冲突；汇总分不能覆盖该异常，未能验证模型一致性。'};
    return {...verdict, evidence};
  }

  async function run(context, settings, startedGeneration, controller, force) {
    const previousBlock = blocks.get(context.key);
    let rounds = 0, result, completedRecord, timedOut = false;
    const sampleEvidence = [];
    const retryBudget = {used: 0};
    const signal = controller.signal;
    const checkCurrent = () => {
      checkHealthy();
      if (signal.aborted || generation(context.providerId) !== startedGeneration
          || (!force && !policy(context.providerId).enabled)) {
        throw failure('guard_unverified', '检测已取消或设置已改变，请重试。');
      }
    };
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(); reject(failure('guard_unverified', '整次检测超过 10 分钟，已停止；未能验证模型一致性。'));
      }, TIMEOUT_MS);
      timer.unref?.();
    });
    const work = (async () => {
      checkCurrent();
      if (!previousBlock) put(context, {status: 'checking', reason: '正在检测三个独立数字样本。'});
      const progress = round => (sample, retry) => {
        checkCurrent();
        const flight = flights.get(context.key);
        if (flight?.controller === controller) flight.progress = {round, sample, samplesPerRound: 3, ...retry};
        const record = records.get(context.key);
        // Progress is transient; persist only meaningful state transitions and
        // final evidence rather than rewriting the history file for each sample.
        if (record && !blocks.has(context.key)) records.set(context.key, {...record,
          status: round === 1 ? 'checking' : 'suspect', rounds: round - 1,
          reason: '第 ' + round + ' 轮：正在采集第 ' + sample + '/3 个独立样本（每个最多等待 180 秒）。'});
      };
      const collectRound = async round => {
        const {evidence, ...verdict} = await scoreRound(context, signal, progress(round), retryBudget);
        if (evidence) sampleEvidence.push(evidence);
        return verdict;
      };
      result = await collectRound(1); rounds = 1; checkCurrent();
      if (result.outcome === 'unverified' && result.reason) {
        // Revoke output admitted before this manual recheck, even if the
        // transient conflict is resolved before the watcher next polls.
        keyGenerations.set(context.key, keyGeneration(context.key) + 1);
        throw failure('guard_unverified', result.reason);
      }
      if (result.outcome === 'difference') {
        // Revoke already-admitted output permanently for this check epoch. A
        // quick inconclusive confirmation must not erase the brief suspect state
        // before the service's cancellation watcher has had time to observe it.
        keyGenerations.set(context.key, keyGeneration(context.key) + 1);
        if (!previousBlock) put(context, {...result, ...(sampleEvidence.length ? {sampleEvidence} : {}), status: 'suspect', rounds,
          reason: '发现指纹差异信号，正在用三个新样本复核。'});
        const confirmation = await collectRound(2); rounds = 2; checkCurrent();
        if (sampleEvidence.length === 2 && sampleEvidence[1].samples.some(current =>
          sampleEvidence[0].samples.some(previous => current.numbers.length === previous.numbers.length
            && current.numbers.every((number, index) => number === previous.numbers[index])))) {
          throw failure('guard_unverified', '复核返回了与首轮完全重复的数字样本，不能视为独立复核，未能验证模型一致性。');
        }
        if (confirmation.outcome === 'difference' && confirmation.prediction === result.prediction) {
          result = confirmation;
          // Store score detail before making the durable latch.
          put(context, {...result, ...(sampleEvidence.length ? {sampleEvidence} : {}), status: 'suspect', rounds, reason: '两轮检测得到相同差异候选。'});
          block(context, '两轮独立数字指纹均与请求模型明显不一致，已锁定供应商的此模型。此结果不是推理能力评分或身份确证。', result.prediction, false);
          throw failure('guard_blocked', blocks.get(context.key).reason);
        }
        const confirmationReason = confirmation.prediction === result.prediction
          ? '复核仍最接近 ' + confirmation.prediction + '（匹配分 ' + confirmation.score.toFixed(3)
            + '），但未满足强差异条件（候选 ≥ 0.8、请求模型 ≤ 0.15、差值 ≥ 0.65）；检测不通过，暂不新增持久锁定。'
          : '首轮最接近 ' + result.prediction + '，复核最接近 ' + confirmation.prediction
            + '；候选发生变化，首轮差异仍保留。检测不通过，暂不新增持久锁定。';
        throw failure('guard_unverified', confirmation.reason || confirmationReason);
      }
      if (result.outcome !== 'passed') throw failure('guard_unverified', '本轮最接近 ' + result.prediction
        + '（匹配分 ' + result.score.toFixed(3) + '），未达到请求模型的通过条件；检测不通过，暂不能确认替代模型。');
      checkCurrent();
      if (blocks.has(context.key) && (!force || blocks.get(context.key) !== previousBlock)) {
        throw failure('guard_blocked', blocks.get(context.key).reason);
      }
      if (force) blocks.delete(context.key);
      cooldowns.delete(context.key);
      const expires = now() + settings.ttlSeconds * 1000;
      const record = put(context, {...result, ...(sampleEvidence.length ? {sampleEvidence} : {}), status: 'passed', rounds, expiresAt: iso(expires),
        reason: '本次独立样本的汇总指纹匹配，未见单样本强差异；不证明实际会话使用同一后端，也不证明推理质量。'});
      completedRecord = record;
      passes.set(context.key, {...record, expires, generation: startedGeneration});
      log('guard-passed', {providerId: context.providerId, model: context.model, rounds});
      return {enabled: settings.enabled, status: 'passed'};
    })();
    try {
      const outcome = await Promise.race([work, timeout]);
      appendHistory(completedRecord, force ? 'manual' : 'automatic');
      return outcome;
    }
    catch (error) {
      const cancelled = signal.aborted && !timedOut;
      controller.abort();
      if (error.code === 'guard_blocked' && !blocks.has(context.key)) {
        block(context, '检测响应出现模型标识不一致，已锁定该模型。', undefined, false);
      }
      const details = {status: 'unverified', reason: error.code?.startsWith('guard_') ? text(error.message)
        : '检测连接或评分失败，未能验证；这不代表模型降智。', rounds,
        prediction: result?.prediction || null, score: result?.score ?? null, gap: result?.gap ?? null,
        ...(sampleEvidence.length ? {sampleEvidence} : {})};
      if (!cancelled && !blocks.has(context.key) && !fatal && generation(context.providerId) === startedGeneration) {
        details.retryAt = rememberFailure(context, error.code === 'guard_unsupported' ? error.code : 'guard_unverified', details.reason);
        put(context, details);
      }
      if (!fatal) appendHistory(error.code === 'guard_blocked' && blocks.has(context.key)
        ? makeRecord(context, {...details, status: 'blocked', reason: blocks.get(context.key).reason,
          prediction: blocks.get(context.key).prediction}) : makeRecord(context, details), force ? 'manual' : 'automatic');
      if (error.code?.startsWith('guard_')) throw error;
      throw failure('guard_unverified', '检测连接或评分失败，未能验证；这不代表模型降智。');
    } finally { clearTimeout(timer); }
  }

  async function ensure(context, {force = false, signal} = {}) {
    if (closed) throw failure('guard_unverified', '过滤服务正在关闭。');
    checkHealthy(); safeContext(context);
    if (signal?.aborted) throw failure('guard_unverified', '请求已取消。');
    const settings = policy(context.providerId);
    if (!settings.enabled && !force) return {enabled: false};
    const currentGeneration = generation(context.providerId);
    if (!force && blocks.has(context.key)) throw failure('guard_blocked', blocks.get(context.key).reason);
    let flight = flights.get(context.key);
    const cooldown = activeCooldown(context.key);
    if (!flight && !force && cooldown) rejectCooldown(cooldown);
    if (!models.includes(context.model)) {
      const details = {status: 'unsupported', reason: '当前指纹库不支持模型 ' + text(context.model, 256) + '，已阻止受保护请求。'};
      passes.delete(context.key);
      if (!blocks.has(context.key)) details.retryAt = rememberFailure(context, 'guard_unsupported', details.reason);
      const record = !blocks.has(context.key) ? put(context, details) : makeRecord(context, details);
      appendHistory(record, force ? 'manual' : 'automatic');
      throw failure('guard_unsupported', '当前指纹库不支持该模型，无法验证；请关闭该供应商检测或选择受支持模型。');
    }
    const passed = passes.get(context.key);
    // Manual rechecks take precedence over an older pass. A normal request must
    // wait until their possible difference signal has been resolved.
    if (!flight && !force && passed && passed.expires > now() && passed.generation === currentGeneration) {
      admissions.set(context, {generation: currentGeneration, keyGeneration: keyGeneration(context.key)});
      return {enabled: true, status: 'passed'};
    }
    if (!flight) {
      // An inconclusive explicit recheck must not resurrect the older cached
      // pass after its promise rejects.
      passes.delete(context.key); cooldowns.delete(context.key);
      const controller = new AbortController();
      flight = {controller, context, generation: currentGeneration, promise: null};
      flights.set(context.key, flight);
      flight.promise = run(context, settings, currentGeneration, controller, force).finally(() => {
        if (flights.get(context.key) === flight) flights.delete(context.key);
      });
    }
    const result = await waitFor(flight.promise, signal);
    if (generation(context.providerId) !== currentGeneration || (!force && !policy(context.providerId).enabled)) {
      throw failure('guard_unverified', '检测设置已改变，请重试。');
    }
    if (settings.enabled) {
      admissions.set(context, {generation: currentGeneration, keyGeneration: keyGeneration(context.key)});
      assertAllowed(context);
    }
    return result;
  }

  function snapshot() {
    const visible = [...records.values()].map(record => {
      const passed = passes.get(record.key), settings = providers.get(record.providerId) || DEFAULT_POLICY;
      const cacheValid = !!(record.status === 'passed' && !fatal && settings.enabled
        && !blocks.has(record.key) && !flights.has(record.key) && passed
        && passed.generation === generation(record.providerId) && passed.expires > now());
      const copy = {...structuredClone(record), cacheValid, retryAt: record.retryAt || null, cooldownActive: false, retryAfterSeconds: 0};
      const cooldown = activeCooldown(record.key);
      if (cooldown && !fatal && settings.enabled && !blocks.has(record.key) && !flights.has(record.key)) {
        Object.assign(copy, {cooldownActive: true, retryAt: iso(cooldown.until),
          retryAfterSeconds: Math.max(1, Math.ceil((cooldown.until - now()) / 1000))});
      }
      if (copy.status === 'passed' && !cacheValid) {
        copy.cacheReason = fatal || (!settings.enabled ? '该供应商的检测已关闭。'
          : settings.ttlSeconds === 0 ? '已设置每次请求检测，下次请求仍须重新检测。'
          : cacheReasons.get(record.key) || (passed?.expires <= now()
            ? '上次检测已过期，下次请求需要重新检测。' : '当前没有可复用的检测结果，下次请求需要重新检测。'));
      }
      return copy;
    }).sort((a, b) => String(b.checkedAt || '').localeCompare(String(a.checkedAt || '')));
    return {models: [...models], providers: Object.fromEntries(providers), records: visible,
      history: structuredClone(history), historyLimit: MAX_HISTORY, failureCooldownSeconds: FAILURE_COOLDOWN_SECONDS,
      checking: [...flights.values()].map(entry => ({...safeContext(entry.context), ...(entry.progress ? {progress: {...entry.progress}} : {})})), ...(fatal ? {error: fatal} : {})};
  }

  return {policy, configure, invalidate, ensure, assertAllowed, block, clear, snapshot,
    async close() {
      closed = true;
      for (const flight of flights.values()) flight.controller.abort();
      await Promise.allSettled([...flights.values()].map(flight => flight.promise));
    }};
}

module.exports = {createGuard, classify, validatePolicy, FAILURE_COOLDOWN_SECONDS, TIMEOUT_MS};
