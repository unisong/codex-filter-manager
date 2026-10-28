'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {providerBase,topString} = require('./config.cjs');
const {probe: apiProbe, guardFailure} = require('./guard-transport.cjs');

function readRoute(databasePath, upstream) {
  let db;
  try {
    db = new DatabaseSync(databasePath, {readOnly: true});
    db.exec('BEGIN');
    const proxy = db.prepare("SELECT * FROM proxy_config WHERE app_type='codex'").get();
    const rows = db.prepare("SELECT id,name,settings_config FROM providers WHERE app_type='codex' AND is_current=1").all();
    if (rows.length !== 1) throw new Error('selection');
    const row = rows[0];
    const settings = JSON.parse(row.settings_config);
    const entry = typeof settings.config === 'string' && !/"""|'''/.test(settings.config) && providerBase(settings.config);
    const url = entry && new URL(entry.url);
    const available = !!(proxy && proxy.auto_failover_enabled === 0 && url
      && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password);
    return {providerId: row.id, providerName: row.name, available,
      reason: available ? null : '供应商路由无法固定验证。请关闭 CC Switch 自动故障转移并检查供应商地址。',
      digest: createHash('sha256').update(JSON.stringify([row.id,row.settings_config,proxy,upstream])).digest('hex')};
  } catch {
    return {available: false, reason: '无法读取 CC Switch 当前供应商，已停止受保护请求。'};
  } finally { db?.close(); }
}

function createGuardService({runtime, databasePath, configPath, getUpstream, log = () => {},
  probe = apiProbe, engineFactory}) {
  const active = new Map();
  const recent = new Map();
  const recentModels = new Map();
  const jobs = new Map();
  let lastRoute;
  let settingsRevision = randomUUID();
  let routeRevision = randomUUID();
  const budget = {bytes: 0, limit: 64 * 1024 * 1024};
  const factory = engineFactory || require('./guard.cjs').createGuard;
  const engine = factory({runtime,log,
    probe: async options => {
      assertRoute(options.context);
      const result = await probe(options);
      assertRoute(options.context);
      return result;
    },
    onBlock: context => {
      for (const controller of active.get(context.key) || []) controller.abort();
    }});
  function route() {
    const current = readRoute(databasePath,getUpstream());
    const signature = current.available ? current.digest : 'unavailable';
    if (lastRoute && lastRoute.signature !== signature) {
      routeRevision = randomUUID();
      recent.clear(); recentModels.clear();
      // Invalidate temporary trust on an observed switch; stable keys retain
      // durable blocks when the user later returns to the original provider.
      if (lastRoute.providerId) engine.invalidate?.(lastRoute.providerId);
      if (current.providerId && current.providerId !== lastRoute.providerId) engine.invalidate?.(current.providerId);
    }
    lastRoute = {signature,providerId:current.providerId};
    return current;
  }
  function hasEnabled() {
    const state = engine.snapshot();
    if (state.error) throw guardFailure(state.error);
    return Object.entries(state.providers).some(([id, p]) => p.enabled && !id.startsWith('magpie:'));
  }
  const contextKey = (current,model,effort) => createHash('sha256').update(JSON.stringify([current.digest,model,effort])).digest('hex');
  function makeContext(input, transport, observed = false) {
    const current = route(input?.model);
    if (!current.available) {
      if ((current.providerId && engine.policy(current.providerId).enabled) || hasEnabled()) throw guardFailure(current.reason);
      return null;
    }
    if (typeof input?.model !== 'string' || !input.model.trim() || input.model.length > 160 || /[\u0000-\u001f\u007f]/.test(input.model)) throw guardFailure('请求模型名称无法验证。');
    const effort = input.reasoning?.effort ?? 'default';
    if (typeof effort !== 'string' || !effort.trim() || effort.length > 40 || /[\u0000-\u001f\u007f]/.test(effort)) throw guardFailure('推理设置无法验证。');
    const model = input.model;
    const key = contextKey(current,model,effort);
    const safeHeaders = {};
    for (const key of ['authorization','x-api-key','api-key','user-agent','originator','openai-beta','openai-organization','openai-project']) {
      if (transport.headers?.[key]) safeHeaders[key] = transport.headers[key];
    }
    const context = {key,providerId:current.providerId,providerName:current.providerName,model,effort,
      routeDigest:current.digest,transport:{...transport,headers:safeHeaders}};
    // Only project traffic updates the observed model. Manual probes must not
    // make their selected model look like a request from the user's chat.
    if (observed) {
      context.observedAt = new Date().toISOString();
      recent.set(current.providerId,context);
      let contexts = recentModels.get(current.providerId);
      if (!contexts) { contexts = new Map(); recentModels.set(current.providerId,contexts); }
      contexts.delete(key); contexts.set(key,context);
      while (contexts.size > 20) contexts.delete(contexts.keys().next().value);
    }
    return context;
  }
  function assertRoute(context) {
    const current = route(context.requestModel);
    if (!current.available || current.digest !== context.routeDigest) throw guardFailure('检测或请求期间供应商配置已切换，请在新路由下重试。');
  }
  async function prepare(input,transport,signal) {
    const context = makeContext(input,transport,true);
    if (!context || !engine.policy(context.providerId).enabled) return null;
    if (/\/compact\/?$/.test(transport.path)) throw guardFailure('模型保护暂不支持加密压缩响应，请使用普通 Responses 请求。');
    await engine.ensure(context,{signal});
    assertRoute(context);
    engine.assertAllowed(context);
    return context;
  }
  function assertCurrent(context) { assertRoute(context); engine.assertAllowed(context); }
  function watch(context, controller) {
    let set = active.get(context.key);
    if (!set) { set = new Set(); active.set(context.key,set); }
    set.add(controller);
    const timer = setInterval(() => {
      try { assertCurrent(context); } catch { controller.abort(); }
    },250);
    timer.unref();
    return () => { clearInterval(timer); set.delete(controller); if (!set.size) active.delete(context.key); };
  }
  function configuredContext(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw guardFailure('手动检测设置无效。');
    const current = route();
    if (!current.available) throw guardFailure(current.reason);
    if (payload.providerId && payload.providerId !== current.providerId) throw guardFailure('请先在 CC Switch 切换到此供应商，再运行检测。');
    if (payload.routeRevision !== undefined && payload.routeRevision !== routeRevision) throw guardFailure('供应商路由已改变，请刷新页面并核对所选模型后重试。');
    const previous = recent.get(current.providerId);
    const cached = previous?.routeDigest === current.digest ? previous : null;
    let text;
    try { text = fs.readFileSync(configPath,'utf8'); } catch { throw guardFailure('无法读取 Codex 配置。'); }
    const configuredModel = topString(text,'model'), configuredEffort = topString(text,'model_reasoning_effort') || 'default';
    const model = payload.model ?? cached?.model ?? configuredModel;
    // An explicit model must not inherit another model's recently observed
    // effort. The UI submits both fields; omitted effort uses matching context.
    const latestMatching = [...(recentModels.get(current.providerId)?.values() || [])].reverse()
      .find(context => context.routeDigest === current.digest && context.model === model);
    const effort = payload.effort ?? latestMatching?.effort ?? (model === configuredModel ? configuredEffort : 'default');
    const matching = recentModels.get(current.providerId)?.get(contextKey(current,model,effort));
    // Keep only probe-relevant authentication/client headers in memory.
    let headers = matching?.transport.headers || cached?.transport.headers;
    if (!headers) {
      let auth;
      try { auth = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath),'auth.json'),'utf8')); } catch {}
      if (!auth?.OPENAI_API_KEY) throw guardFailure('请先通过此供应商发送一次请求，再运行手动检测。');
      headers = {authorization:'Bearer '+auth.OPENAI_API_KEY,originator:'codex_cli_rs'};
    }
    let apiPath = '/v1/responses';
    try { apiPath = new URL(providerBase(text).url).pathname.replace(/\/$/,'')+'/responses'; } catch {}
    return makeContext({model,reasoning:{effort}},{upstream:getUpstream(),path:apiPath,headers});
  }
  function snapshot() {
    const current = route();
    const previous = recent.get(current.providerId);
    const cached = previous?.routeDigest === current.digest ? previous : null;
    let configured = {};
    try { const text = fs.readFileSync(configPath,'utf8'); configured = {model:topString(text,'model'),effort:topString(text,'model_reasoning_effort') || 'default'}; } catch {}
    let model = cached?.model || configured.model, effort = cached?.effort || configured.effort;
    effort ||= 'default';
    const state = engine.snapshot();
    return {...state,settingsRevision,current:{key:current.available&&model ? contextKey(current,model,effort) : undefined,
      providerId:current.providerId,model,effort,routeRevision,requestModel:cached?.requestModel || current.requestModel,modelSource:cached?'request':model?'config':'unknown',
      modelObservedAt:cached?.observedAt,available:current.available,reason:current.reason},configured,
      currentRecords:(state.records || []).filter(record=>current.available && record.key===contextKey(current,record.model,record.effort)),
      recentModels:[...(recentModels.get(current.providerId)?.values() || [])].filter(context=>context.routeDigest===current.digest)
        .reverse().map(({key,model,effort,observedAt})=>({key,model,effort,observedAt})),
      jobs:[...jobs.keys()],manualJobs:[...jobs.values()].map(({key,providerId,model,effort})=>({key,providerId,model,effort}))};
  }
  return {prepare,assertCurrent,watch,budget,snapshot,
    close: () => engine.close?.(),
    observe(input,transport) {
      // Read-only best effort for displaying the actual most recent model, even
      // when automatic protection is off. Never change passthrough semantics.
      try { makeContext(input,transport,true); } catch {}
    },
    shouldInspect() {
      if (!hasEnabled()) return false;
      const current = route();
      return !current.available || engine.policy(current.providerId).enabled;
    },
    block(context,actual) { engine.block(context,'上游返回的模型名称与请求不一致。',actual); },
    configure(id,settings,expectedRevision) {
      // Management supplies a revision; in-process startup/test callers may
      // omit it. The check and mutation are synchronous, so they cannot race.
      if (arguments.length >= 3 && expectedRevision !== settingsRevision) {
        throw guardFailure('模型保护设置已在其他页面更新。本次修改未保存，请刷新后重试。','guard_settings_changed');
      }
      const wasConfigured = Object.hasOwn(engine.snapshot().providers,id);
      const previous = engine.policy(id);
      const result = engine.configure(id,settings);
      if (!wasConfigured || previous.enabled !== result.enabled || previous.ttlSeconds !== result.ttlSeconds) settingsRevision = randomUUID();
      return result;
    },
    clear(key) { return engine.clear(key); },
    check(payload) {
      const context = configuredContext(payload);
      if (!context) throw guardFailure('没有可验证的供应商。');
      if (!jobs.has(context.key)) {
        jobs.set(context.key,context);
        Promise.resolve().then(() => engine.ensure(context,{force:true})).catch(error => {
          log('guard-manual-check-finished',{code:error.code || 'guard_unverified'});
        }).finally(() => jobs.delete(context.key));
      }
    }
  };
}

module.exports = {createGuardService,readRoute,topString};
