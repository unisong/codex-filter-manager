'use strict';

// Read-only Magpie adapter. Provider keys are used only in a route digest;
// requests and probes always go through the user's running local gateway.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {topString, providerBase, providerPolicy, sameEndpoint} = require('./config.cjs');
const {localOrigin} = require('./proxy.cjs');

const defaultDirectory = () => path.join(os.homedir(), '.config', 'magpie');
function optionalFile(filename, fallback) {
  try { return fs.readFileSync(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function discoverMagpie(directory = defaultDirectory()) {
  const settings = JSON.parse(optionalFile(path.join(directory, 'settings.json'), '{}'));
  const port = settings.port || 3425;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Magpie gateway port.');
  return localOrigin('http://127.0.0.1:' + port);
}
function detectBackend(options) {
  if (options.backend && options.backend !== 'auto') return options.backend;
  try {
    const text = fs.readFileSync(options.configPath, 'utf8');
    if (topString(text, 'model_provider') === 'magpie') return 'magpie';
    const base = providerBase(text);
    if (base && sameEndpoint(base.url, discoverMagpie(options.magpieDirectory))) return 'magpie';
    const backup = JSON.parse(optionalFile(path.join(options.runtime, 'routes.json'), '{}'));
    const original = backup.routes?.find(([id]) => id === base?.provider)?.[1]?.originalUrl;
    if (original && sameEndpoint(original, discoverMagpie(options.magpieDirectory))) return 'magpie';
  } catch { /* An explicitly selected backend can diagnose unreadable config. */ }
  return 'ccswitch';
}
function createMagpieAdapter({directory = defaultDirectory(), configPath, getUpstream}) {
  const configuredModel = () => topString(fs.readFileSync(configPath, 'utf8'), 'model');
  function load() {
    const raw = fs.readFileSync(path.join(directory, 'providers.json'), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.providers) || data.providers.some(p => !p || typeof p.id !== 'string')
        || new Set(data.providers.map(p => p.id)).size !== data.providers.length) throw new Error('Invalid Magpie providers.');
    const settings = optionalFile(path.join(directory, 'settings.json'), '{}');
    JSON.parse(settings);
    const plugins = optionalFile(path.join(directory, 'plugins.yml'), '');
    // Custom middleware may rewrite a request before Magpie resolves its model.
    // Only the built-in preset is understood here; never guess at custom YAML.
    const pluginList = JSON.parse(optionalFile(path.join(directory, 'plugins.json'), '{"plugins":[]}'));
    const ownPackage = path.resolve(__dirname, 'magpie-plugin');
    const customPlugins = plugins.split(/\r?\n/).some(line => line.trim() && !/^\s*(?:#|preset:\s*(?:all|none)\s*(?:#.*)?$)/.test(line))
      || (pluginList.plugins || []).some(p => !p.off && p.spec !== ownPackage);
    return {data, customPlugins, digest: createHash('sha256').update(JSON.stringify([raw, settings, plugins, pluginList, getUpstream()])).digest('hex')};
  }
  function resolve(snapshot, requestModel) {
    const unknown = reason => ({available: false, reason, requestModel});
    if (typeof requestModel !== 'string' || !requestModel.includes('/')) return unknown('Magpie 需使用明确的「供应商/模型」路由；裸模型名、自动路由组和自动审查替代模型暂不能固定验证。');
    if ((snapshot.data.groups || []).some(g => [g.id, g.name].includes(requestModel))) return unknown('Magpie 自动路由组暂不能固定验证，请选择明确的供应商/模型。');
    const slash = requestModel.indexOf('/'), prefix = requestModel.slice(0, slash), model = requestModel.slice(slash + 1);
    const matches = snapshot.data.providers.filter(p => p.id === prefix || (Array.isArray(p.was) && p.was.includes(prefix)));
    if (matches.length !== 1 || !model) return unknown('无法识别 Magpie 请求中的供应商前缀，请刷新供应商列表。');
    const p = matches[0];
    let endpoint = '';
    try {
      const url = new URL(p.responses || p.chat || p.anthropic || p.gemini);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) endpoint = url.origin;
    } catch {}
    const reason = p.off ? '此 Magpie 供应商已关闭。'
      : !endpoint ? '此 Magpie 供应商使用订阅登录或插件，暂不能固定验证。'
      : p.fallback?.length ? '此 Magpie 供应商配置了故障转移；请先关闭 fallback，再进行固定路由检测。'
      : snapshot.customPlugins ? '发现自定义 Magpie 插件配置，暂不能验证其是否改写路由。'
      : null;
    return {available: !reason, reason, providerId: 'magpie:' + p.id, providerName: p.name || p.id,
      endpoint, model, requestModel, gatewayProvider: p.id,
      digest: createHash('sha256').update(JSON.stringify([snapshot.digest, p.id])).digest('hex')};
  }
  function route(requestModel) {
    try { return resolve(load(), requestModel ?? configuredModel()); }
    catch { return {available: false, reason: '无法读取 Magpie 供应商或路由配置，已停止受保护请求。'}; }
  }
  function policyFor(current, overrides) {
    if (!current.available) return {filter: false, mode: 'passthrough', provider: 'unknown', reason: 'magpie-route-unverified'};
    // Older private CC Switch installations may retain built-in domain rules.
    // Magpie rules are always explicit and never inherit those defaults.
    if (!Object.hasOwn(overrides, current.providerId)) return {filter: false, mode: 'passthrough', provider: 'unknown', reason: 'not-configured'};
    return providerPolicy('model_provider="magpie"\n[model_providers.magpie]\nbase_url=' + JSON.stringify(current.endpoint), overrides[current.providerId]);
  }
  function listProviders(overrides) {
    const snapshot = load(), current = resolve(snapshot, configuredModel());
    return {autoFailover: false, backend: {id: 'magpie', name: 'Magpie', requestRouting: true},
      providers: snapshot.data.providers.map(p => {
        const r = resolve(snapshot, p.id + '/' + (p.models?.[0] || 'unlisted'));
        const id = 'magpie:' + p.id, override = overrides[id];
        const policy = policyFor(r, overrides);
        return {id, name: p.name || p.id, current: id === current.providerId, endpoint: r.endpoint || '',
          editable: !!r.endpoint, guardAvailable: r.available, routeReason: r.reason,
          source: override ? 'custom' : 'default', policy, defaultEnabled: false,
          rule: override || {historyFilter: false, preserveEncryptedInclude: true, stripResponsesLiteHeader: false}};
      }).sort((a, b) => Number(b.current) - Number(a.current))};
  }
  return {id: 'magpie', name: 'Magpie', route, listProviders,
    policy: (overrides, input) => policyFor(route(input === undefined ? undefined : input?.model || ''), overrides),
    requestModel: (model, current) => model.includes('/') ? model : current.gatewayProvider + '/' + model};
}

module.exports = {createMagpieAdapter, discoverMagpie, detectBackend, defaultDirectory};
