import fs from 'node:fs';
const productVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import path from 'node:path';
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {generateChallenges} from '../vendor/modeltrace/challenge-browser.mjs';
import {combineMiddleware} from './middleware.mjs';
const require = createRequire(import.meta.url);
const {analyzeSamples} = require('./evidence.cjs');
const {probe: transportProbe} = require('./transport.cjs');
const bank = JSON.parse(fs.readFileSync(new URL('../vendor/modeltrace/unified_bank.json', import.meta.url)));
const cleanError = e => e?.code?.startsWith('guard_') || e?.status ? e.message : '检测服务遇到异常，请查看诊断状态后重试。';
export const fail = (message, status = 400) => Object.assign(new Error(message), {status});
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  try { fs.writeFileSync(temp, value, {flag: 'wx', mode: 0o600}); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
export function assess(evidence, expected) {
  const {aggregate: a, samples, flags} = evidence;
  const difference = s => s.prediction !== expected && s.score >= .8 && s.expectedScore <= .15 && s.score - s.expectedScore >= .65;
  if (flags.repeatedSamples) return 'suspect';
  if (difference(a) && samples.filter(difference).length >= 2) return 'difference';
  if (a.prediction === expected && a.score >= .5 && !flags.conflictingSamples) return 'matched';
  return 'suspect';
}
export function gateCode(targets, secret) {
  const holds = Object.fromEntries(targets.filter(t => t.mode === 'protect' && t.paused && !(t.allowUntil > Date.now()))
    .map(t => [t.model, true]));
  return `// Generated locally. No history edits, network calls or project content logging.\nconst holds=${JSON.stringify(holds)};\nconst bypass=${JSON.stringify('workbench-probe/' + secret + '/')};\nexport function onRequest(body,ctx){\n if(!body||typeof body.model!=="string")return;\n if(body.model.startsWith(bypass))return {...body,model:body.model.slice(bypass.length)};\n if(Object.prototype.hasOwnProperty.call(holds,body.model))ctx.reject(409,"[MODEL_WORKBENCH_PAUSED] 此模型已被一致性工作台暂停。本次请求未发往上游；请打开工作台查看原因、重检或限时放行。");\n}\n`;
}
export function createEngine({directory, gateFile, gateway, routeVersion = () => '', probe = transportProbe,
  wait = delay, now = Date.now, tickMs = 30000, historyLimit = 100}) {
  const file = path.join(directory, 'state.json');
  let state = {schema: 1, revision: 0, targets: [], history: [], daily: {}, dailyLimit: 60};
  let health = '', closed = false;
  const jobs = new Map(), secret = randomBytes(24).toString('hex');
  const models = bank.models.map(m => m.id);
  // A corrupt state is never silently replaced: unknown protection intent is
  // surfaced and the existing gate is retained until the file is repaired.
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.schema !== 1 || !Array.isArray(saved.targets) || !Array.isArray(saved.history)
        || !saved.daily || typeof saved.daily !== 'object' || !Number.isInteger(saved.dailyLimit)
        || saved.dailyLimit < 3 || saved.dailyLimit > 1000 || saved.targets.some(t =>
          !t || typeof t.id !== 'string' || typeof t.model !== 'string' || !t.model.includes('/')
          || !['manual', 'observe', 'protect'].includes(t.mode) || !models.includes(t.expected)
          || ![10,30,60,120].includes(t.intervalMinutes) || typeof t.paused !== 'boolean')
        || saved.history.some(r => !r || !Array.isArray(r.rounds) || r.rounds.some(x => !Array.isArray(x.samples)))) throw Error('state');
    state = saved;
    for (const record of state.history) if (record.status === 'running') {
      record.status = 'incomplete'; record.reason = '后台曾重启，本轮没有完成；未自动追加模型请求。'; record.finishedAt = now();
    }
  } catch (e) { if (e.code !== 'ENOENT') health = '状态文件无法读取；保留已有保护文件，暂不可修改或检测。请备份并修复 state.json。'; }
  // Verify all copied scoring assets before using executable vendor code.
  const manifest = JSON.parse(fs.readFileSync(new URL('../vendor/modeltrace/PROVENANCE.json', import.meta.url)));
  for (const [name, item] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(new URL('../vendor/modeltrace/' + name, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) health = 'ModelTrace 文件校验失败，检测已停用。';
  }
  const save = () => {
    state.revision++;
    state.history = state.history.slice(0, historyLimit);
    const days = Object.keys(state.daily).sort().slice(-8);
    state.daily = Object.fromEntries(days.map(k => [k, state.daily[k]]));
    try { atomic(file, JSON.stringify(state, null, 2)); }
    catch { health = '状态记录写入失败，已停止新增检测。请检查磁盘和目录权限后重启工作台。'; throw fail(health, 503); }
  };
  const publish = () => {
    if (health) throw fail(health, 503);
    // Hold expiry lives in the code as a timestamp as well, so a stopped
    // coordinator cannot turn a 15-minute allowance into a permanent bypass.
    const entries = state.targets.filter(t => t.mode === 'protect' && t.paused)
      .map(t => [t.model, t.allowUntil || 0]);
    let code = gateCode([], secret);
    code = code.replace('const holds={};', 'const holds=' + JSON.stringify(Object.fromEntries(entries)) + ';')
      .replace('if(Object.prototype.hasOwnProperty.call(holds,body.model))',
        'if(Object.prototype.hasOwnProperty.call(holds,body.model)&&Date.now()>=holds[body.model])');
    atomic(gateFile, combineMiddleware(code));
  };
  function persistGate() {
    try { save(); publish(); }
    catch { health = '设置或保护文件写入失败；暂停更改设置。请检查磁盘和目录权限。'; throw fail(health, 503); }
  }
  if (!health) persistGate();
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const used = () => state.daily[day()] || 0;
  const target = id => state.targets.find(t => t.id === id);
  const healthy = () => { if (closed || health) throw fail(health || '后台已关闭。', 503); };
  function snapshot() {
    return {version: productVersion, health, revision: state.revision, bankVersion: manifest.commit,
      candidates: models, daily: {used: used(), limit: state.dailyLimit, day: day()},
      targets: state.targets.map(t => ({...t, running: jobs.has(t.id),
        stale: !t.lastChecked || now() - t.lastChecked > t.intervalMinutes * 60000,
        routeChanged: !!t.lastRoute && t.lastRoute !== routeVersion()})),
      history: state.history.map(({rounds, ...r}) => ({...r, rounds: rounds.map(({samples, ...x}) =>
        ({...x, samples: samples.map(({text, prompt, numbers, ...s}) => s)}))}))};
  }
  function update(input) {
    healthy();
    if (!input || typeof input.model !== 'string' || !/^[^/\s]+\/.+/.test(input.model)
        || input.model.length > 200 || /[\x00-\x1f\x7f]/.test(input.model)
        || input.model.startsWith('workbench-probe/')) throw fail('请选择完整的「供应商/模型」。');
    if (!models.includes(input.expected)) throw fail('请选择参考库中的期望模型。');
    if (!['manual', 'observe', 'protect'].includes(input.mode)
        || !['default', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(input.effort)
        || ![10, 30, 60, 120].includes(input.intervalMinutes)) throw fail('检测设置无效。');
    if (input.mode === 'protect' && /^(group|auto|router)\//i.test(input.model)) throw fail('路由组仅支持观测，请选择具体供应商模型后再开启暂停保护。');
    let t = input.id ? target(input.id) : state.targets.find(t => t.model === input.model && t.effort === input.effort);
    if (input.id && !t) throw fail('检测目标不存在。', 404);
    if (t && jobs.has(t.id)) throw fail('此目标正在检测，请先取消或等待完成。', 409);
    if (state.targets.some(other => other.id !== t?.id && other.model === input.model)) throw fail('此完整模型已有目标。请编辑已有条目，避免保护规则相互覆盖。', 409);
    if (!t) {
      if (state.targets.length >= 50) throw fail('最多配置 50 个目标。');
      t = {id: randomUUID(), paused: false, allowUntil: 0}; state.targets.push(t);
    }
    const changed = t.model && [t.model, t.expected, t.effort].join('|') !== [input.model, input.expected, input.effort].join('|');
    if (changed) { t.lastChecked = 0; t.lastResult = null; t.lastRoute = ''; }
    Object.assign(t, {model: input.model, expected: input.expected, mode: input.mode, effort: input.effort,
      intervalMinutes: input.intervalMinutes, nextAt: now() + input.intervalMinutes * 60000});
    persistGate(); return t;
  }
  function action(id, op) {
    healthy(); const t = target(id); if (!t) throw fail('检测目标不存在。', 404);
    if (op === 'cancel') { jobs.get(id)?.controller.abort(); return; }
    if (op === 'pause') { t.paused = true; t.pauseReason = '人工暂停'; t.allowUntil = 0; }
    else if (op === 'allow') { t.allowUntil = now() + 15 * 60000; }
    else if (op === 'resume') { t.paused = false; t.allowUntil = 0; t.pauseReason = ''; }
    else if (op === 'delete') {
      if (jobs.has(id)) throw fail('请先取消检测并等待结束。', 409);
      state.targets = state.targets.filter(x => x.id !== id);
    } else throw fail('未知操作。');
    persistGate();
  }
  async function sample(t, challenge, job, record, retryBudget) {
    let retries = 0;
    const s = {id: challenge.id, prompt: challenge.prompt, expectedCount: challenge.expected_count,
      text: '', status: 'running', attempts: [], startedAt: now()};
    record.rounds.at(-1).samples.push(s); save();
    for (;;) {
      if (job.controller.signal.aborted) throw fail('检测已取消。');
      if (routeVersion() !== record.route) throw fail('检测期间 Magpie 路由配置已变化，本轮停止。');
      if (used() >= state.dailyLimit) throw fail('今日请求预算已用完，本轮停止。');
      state.daily[day()] = used() + 1;
      const attempt = {startedAt: now(), status: 'running'}; s.attempts.push(attempt); save();
      try {
        const gw = gateway();
        const slash = t.model.indexOf('/');
        const response = await probe({signal: job.controller.signal, prompt: challenge.prompt,
          context: {model: t.model.slice(slash + 1), requestModel: 'workbench-probe/' + secret + '/' + t.model,
            gatewayProvider: t.model.slice(0, slash), effort: t.effort,
            transport: {upstream: gw.url, path: '/v1/responses', headers: {'user-agent': 'magpie-workbench-probe/0.2',
              ...(gw.key ? {authorization: 'Bearer ' + gw.key} : {})}}}});
        if (job.controller.signal.aborted) throw fail('检测已取消。');
        s.text = String(response.text || '').slice(0, 65536); s.usage = response.usage || null; s.reportedModel = response.model;
        if (String(response.text || '').length > 65536) throw fail('样本正文超出上限，未用于评分。');
        s.status = 'completed'; attempt.status = 'completed'; attempt.finishedAt = now();
        save(); return s;
      } catch (e) {
        attempt.status = 'failed'; attempt.reason = job.controller.signal.aborted ? '检测已取消。' : cleanError(e);
        attempt.finishedAt = now(); s.status = 'failed'; s.reason = attempt.reason; save();
        if (job.controller.signal.aborted) throw fail('检测已取消。');
        if (!e.retryable || retryBudget.used >= 3) throw fail(attempt.reason);
        const ms = Math.max(1000 * 2 ** retryBudget.used, e.retryAfterMs || 0);
        if (ms > 60000) throw fail('上游要求等待超过 60 秒，本轮停止；请稍后重检。');
        retries++; retryBudget.used++; s.retries = retries; s.status = 'retrying'; save();
        await wait(ms, undefined, {signal: job.controller.signal});
      }
    }
  }
  async function run(t, job, record) {
    const retries = {used: 0};
    try {
      for (let roundIndex = 0; roundIndex < 2; roundIndex++) {
        const round = {samples: [], status: 'running'}; record.rounds.push(round); save();
        for (const challenge of generateChallenges(3)) await sample(t, challenge, job, record, retries);
        if (job.controller.signal.aborted) throw fail('检测已取消。');
        if (routeVersion() !== record.route) throw fail('检测期间路由配置已变化，结果不用于保护。');
        const {evidence} = analyzeSamples(round.samples.map(s => ({text: s.text, expected_count: s.expectedCount})), bank, t.expected);
        round.evidence = evidence; round.status = assess(evidence, t.expected); save();
        if (roundIndex === 0 && round.status === 'difference') {
          record.status = 'running'; record.phase = 'confirming';
          if (t.mode === 'protect') { t.paused = true; t.pauseReason = '检测支持偏离，独立复测中'; t.allowUntil = 0; persistGate(); }
          if (used() + 3 > state.dailyLimit) throw fail('本轮支持偏离，但剩余预算不足以完成三样本复测；尚未形成重复偏离结论。');
          continue;
        }
        record.status = roundIndex === 1
          ? (round.status === 'difference' && round.evidence.aggregate.prediction === record.rounds[0].evidence.aggregate.prediction ? 'deviated' : 'suspect')
          : round.status;
        record.reason = {matched: '三样本支持目标指纹；不是模型身份认证。', suspect: '有效样本存在分歧或证据不足，请查看详情并复核。',
          deviated: '两轮独立检测均支持偏离目标；参考库为有限候选，不构成身份认证。'}[record.status];
        if (t.paused && t.pauseReason === '检测支持偏离，独立复测中') t.pauseReason = record.status === 'deviated'
          ? '两轮独立检测支持偏离，等待人工处理' : '复测未确认一致性，暂停保留，等待人工复核';
        break;
      }
      t.lastChecked = now(); t.lastRoute = record.route; t.lastResult = record.status;
      // A new pass does not silently undo a hold imposed by the user or a
      // previous suspicious check. Resuming is an explicit UI action.
    } catch (e) {
      record.status = job.controller.signal.aborted ? 'cancelled' : 'incomplete';
      record.reason = job.controller.signal.aborted ? '检测已取消；已发送请求可能仍由上游计费。'
        : e.status ? e.message : cleanError(e);
      if (t.paused && t.pauseReason === '检测支持偏离，独立复测中') t.pauseReason = '偏离后的复测未完成，暂停保留，等待人工处理';
      for (const round of record.rounds) if (round.status === 'running') {
        round.status = 'incomplete';
        for (const s of round.samples) if (['running', 'retrying'].includes(s.status)) s.status = 'incomplete';
      }
      t.lastResult = record.status;
    } finally {
      record.finishedAt = now(); record.retries = retries.used;
      record.requests = record.rounds.reduce((n, r) => n + r.samples.reduce((v, s) => v + s.attempts.length, 0), 0);
      t.nextAt = now() + t.intervalMinutes * 60000;
      jobs.delete(t.id);
      try { persistGate(); } catch {}
    }
  }
  function start(id, source = 'manual') {
    healthy(); const t = target(id); if (!t) throw fail('检测目标不存在。', 404);
    if (jobs.has(id)) return jobs.get(id).id;
    if (jobs.size >= 2) throw fail('已有两项检测运行中，请稍后重试。', 409);
    if (used() + 3 > state.dailyLimit) throw fail('今日剩余预算不足以开始三样本检测。', 409);
    const record = {id: randomUUID(), targetId: t.id, model: t.model, expected: t.expected, effort: t.effort,
      source, startedAt: now(), status: 'running', rounds: [], route: routeVersion(), bankVersion: manifest.commit};
    const job = {id: record.id, controller: new AbortController()}; jobs.set(id, job);
    state.history.unshift(record);
    try { save(); } catch (e) { jobs.delete(id); state.history = state.history.filter(r => r !== record); throw e; }
    job.promise = run(t, job, record);
    return record.id;
  }
  const timer = setInterval(() => {
    if (closed || health) return;
    for (const t of state.targets) if (t.mode !== 'manual' && !jobs.has(t.id) && now() >= t.nextAt) {
      try { start(t.id, 'scheduled'); }
      catch { t.nextAt = now() + t.intervalMinutes * 60000; }
    }
  }, tickMs); timer.unref?.();
  return {snapshot, update, action, start,
    record: id => state.history.find(r => r.id === id),
    budget(limit) { healthy(); if (!Number.isInteger(limit) || limit < 3 || limit > 1000) throw fail('每日预算应为 3–1000 个请求。'); state.dailyLimit = limit; save(); },
    async close() { closed = true; clearInterval(timer); for (const j of jobs.values()) j.controller.abort(); await Promise.allSettled([...jobs.values()].map(j => j.promise)); },
  };
}
