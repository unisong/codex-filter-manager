'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {atomicWrite, providerBase, providerPolicy, readFilterPolicy, readLegacyModelAliases} = require('./config.cjs');
const {FilterError} = require('./proxy.cjs');
const RULE_KEYS = ['historyFilter', 'preserveEncryptedInclude', 'stripResponsesLiteHeader'];

function validateRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || Object.keys(rule).some(k => !RULE_KEYS.includes(k))
      || !RULE_KEYS.every(k => typeof rule[k] === 'boolean')) {
    throw new FilterError('invalid_rule', '规则格式无效，请刷新页面后重试。');
  }
  return Object.fromEntries(RULE_KEYS.map(k => [k, rule[k]]));
}

function createManagement({databasePath, runtime, guard, log = () => {}}) {
  const rulesPath = path.join(runtime, 'provider-rules.json');
  const aliasesPath = path.join(runtime, 'legacy-model-aliases.json');
  function readRules() {
    let raw = '';
    try { raw = fs.readFileSync(rulesPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const data = raw ? JSON.parse(raw) : {version: 1, providers: {}};
    if (data.version !== 1 || !data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) {
      throw new FilterError('invalid_rules_file', '本地规则文件格式无效，请从备份恢复。', 500);
    }
    for (const rule of Object.values(data.providers)) validateRule(rule);
    return {raw, data, revision: createHash('sha256').update(raw).digest('hex')};
  }
  function listProviders(overrides) {
    const db = new DatabaseSync(databasePath, {readOnly: true});
    try {
      const rows = db.prepare("SELECT id,name,is_current,CASE WHEN json_valid(settings_config) THEN json_extract(settings_config, '$.config') END AS config FROM providers WHERE app_type='codex' ORDER BY is_current DESC,sort_index,name").all();
      const proxy = db.prepare("SELECT auto_failover_enabled FROM proxy_config WHERE app_type='codex'").get();
      return {autoFailover: proxy?.auto_failover_enabled !== 0, providers: rows.map(row => {
        const inherited = providerPolicy(row.config);
        const override = Object.hasOwn(overrides, row.id) ? overrides[row.id] : null;
        const policy = providerPolicy(row.config, override);
        let endpoint = '';
        try {
          const url = new URL(providerBase(row.config)?.url);
          if (!url.username && !url.password) endpoint = url.origin;
        } catch {}
        return {id: row.id, name: row.name, current: row.is_current === 1, endpoint,
          editable: !!endpoint && !['complex-toml-unidentified', 'base-url-unidentified'].includes(policy.reason),
          source: override ? 'custom' : 'default', policy,
          rule: {historyFilter: policy.filter === true,
            preserveEncryptedInclude: override ? override.preserveEncryptedInclude
              : policy.preserveEncryptedInclude === true || !policy.filter,
            stripResponsesLiteHeader: policy.stripResponsesLiteHeader === true},
          defaultEnabled: inherited.filter === true || inherited.stripResponsesLiteHeader === true};
      })};
    } finally { db.close(); }
  }
  function state() {
    const rules = readRules();
    let aliasConfig;
    try { aliasConfig = JSON.parse(fs.readFileSync(aliasesPath, 'utf8')); } catch {}
    return {...listProviders(rules.data.providers), revision: rules.revision,
      ...(guard ? {guard:guard.snapshot()} : {}),
      aliasCompatibility: {configured: !!aliasConfig, enabled: aliasConfig?.enabled === true,
        activeCount: readLegacyModelAliases(aliasesPath, databasePath).size},
      currentPolicy: readFilterPolicy(databasePath, rules.data.providers)};
  }
  function updateRule(id, rule, revision) {
    const before = readRules();
    if (revision !== before.revision) throw new FilterError('rules_changed', '规则已在其他页面更新。请刷新后重试。', 409);
    const provider = listProviders(before.data.providers).providers.find(p => p.id === id);
    if (!provider || (rule && !provider.editable)) throw new FilterError('unknown_provider', '供应商已移除或地址无法识别，请刷新列表。', 404);
    if (rule === null) delete before.data.providers[id];
    else Object.defineProperty(before.data.providers, id, {value: validateRule(rule), enumerable: true, configurable: true, writable: true});
    if (before.raw) atomicWrite(rulesPath + '.previous', before.raw);
    atomicWrite(rulesPath, JSON.stringify(before.data, null, 2) + '\n');
    log('provider-rule-updated', {providerId: id, reset: rule === null});
    return state();
  }
  return {
    policy: () => readFilterPolicy(databasePath, readRules().data.providers),
    html: token => fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8').replace('__FILTER_TOKEN_JSON__', JSON.stringify(token)),
    icon: () => fs.readFileSync(path.join(__dirname, 'assets', 'favicon.svg')),
    state,
    handle(method, route, payload) {
      if (method === 'GET' && route === '/state') return state();
      const guardProvider = route.match(/^\/guard\/providers\/(.+)$/);
      if (guard && method === 'PUT' && guardProvider) {
        const id = guardProvider[1];
        if (!listProviders(readRules().data.providers).providers.some(p => p.id === id)) throw new FilterError('unknown_provider','供应商已移除，请刷新列表。',404);
        if (typeof payload.revision !== 'string') throw new FilterError('guard_settings_changed','当前页面的模型保护设置已失效。本次修改未保存，请刷新后重试。',409);
        guard.configure(id,{enabled:payload.enabled,ttlSeconds:payload.ttlSeconds},payload.revision);
        return state();
      }
      if (guard && method === 'POST' && route === '/guard/check') {
        guard.check(payload);
        return state();
      }
      if (guard && method === 'POST' && route === '/guard/clear') {
        if (typeof payload.key !== 'string' || !/^[a-f0-9]{64}$/.test(payload.key)) throw new FilterError('invalid_setting','检测记录无效。');
        guard.clear(payload.key);
        return state();
      }
      const match = route.match(/^\/providers\/(.+)\/rule$/);
      if (match && ['PUT', 'DELETE'].includes(method)) return updateRule(match[1], method === 'DELETE' ? null : payload.rule, payload.revision);
      if (method === 'PUT' && route === '/aliases') {
        if (typeof payload.enabled !== 'boolean') throw new FilterError('invalid_setting', '开关值无效。');
        let raw;
        try { raw = fs.readFileSync(aliasesPath, 'utf8'); }
        catch { throw new FilterError('aliases_missing', '当前没有旧模型别名配置。', 404); }
        const data = JSON.parse(raw);
        atomicWrite(aliasesPath + '.previous', raw);
        atomicWrite(aliasesPath, JSON.stringify({...data, enabled: payload.enabled}, null, 2) + '\n');
        log('legacy-aliases-updated', {enabled: payload.enabled});
        return state();
      }
      throw new FilterError('unknown_control_route', '没有这个管理接口。', 404);
    }
  };
}

module.exports = {createManagement, validateRule};
