// Optional read-only support tool. It never starts Magpie, changes settings or calls models.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

const COMMUNITY = '@magpie-community/middleware-codex-history';
const KNOWN = /^(?:github:unisong\/magpie-codex-history-filter(?:#.*)?|(?:magpie-middleware-codex-history|@magpie-community\/middleware-codex-history)(?:@[^\s/]+)?)$/;
function isFilter(spec) {
  return typeof spec === 'string' && (KNOWN.test(spec) || /(?:^|[\\/])(?:magpie-plugin|magpie-codex-history-filter|magpie-model-workbench|codex-workbench|codex-history\.middleware\.js|history\.middleware\.js)[\\/]?$/.test(spec));
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function topString(text, key) {
  const match = text.replace(/^\uFEFF/, '').split(/^\s*\[/m)[0].match(new RegExp('^\\s*' + key + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|\'[^\']*\')\\s*(?:#.*)?$', 'm'));
  if (!match) return null;
  return match[1].startsWith("'") ? match[1].slice(1, -1) : JSON.parse(match[1]);
}
function configBase(text) {
  if (/"""|'''/.test(text)) return null;
  const provider = topString(text, 'model_provider');
  if (!provider) return null;
  let active = false;
  const found = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      const section = line.match(/^\s*\[\s*model_providers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]\s*(?:#.*)?$/);
      let name = section?.[1];
      if (name?.startsWith('"')) name = JSON.parse(name);
      else if (name?.startsWith("'")) name = name.slice(1, -1);
      active = name === provider;
    } else if (active) {
      const match = line.match(/^\s*base_url\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
      if (match) found.push(match[1].startsWith("'") ? match[1].slice(1, -1) : JSON.parse(match[1]));
    }
  }
  return found.length === 1 ? found[0] : null;
}
async function ping(port) {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port});
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  });
}

export async function diagnose({directory = path.join(os.homedir(), '.config', 'magpie'),
  config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'),
  model, now = new Date(), probe = ping} = {}) {
  const report = {schemaVersion: 1, product: 'codex-filter-manager', generatedAt: now.toISOString(),
    toolVersion: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, platform: process.platform, checks: [], plugins: [],
    observation: {source: 'read-only configuration inspection', runtimeCalls: null, filteredRequests: null, removedItems: null, lastRuntimeError: null},
    privacy: 'No prompts, keys, provider names, model names, URLs or file paths. No upload.',
    feedbackUrl: 'https://github.com/unisong/codex-filter-manager/issues/new?template=bug_report.yml'};
  const check = (code, level, message) => report.checks.push({code, level, message});
  let entries = [];
  try {
    const data = readJson(path.join(directory, 'plugins.json'));
    if (!Array.isArray(data.plugins)) throw new Error();
    entries = data.plugins.filter(entry => isFilter(entry?.spec));
  } catch { check('plugins-unreadable', 'error', '无法读取插件清单。检查 Magpie 数据目录或 JSON 格式；工具不会修复或覆盖原文件。'); }
  if (!entries.length) check('filter-not-found', 'error', '未识别到本插件。确认安装的是 Codex History Filter；特殊本地目录或其他 Git 地址可能无法自动识别。');
  const active = entries.filter(entry => entry.off !== true);
  if (entries.length && !active.length) check('filter-disabled', 'warning', '找到本插件，但均已停用。');
  if (active.length > 1) check('duplicate-filters', 'warning', '同时启用了多份历史过滤插件。请保留一份，避免重复处理和规则混淆。');
  let text = '', requested = model;
  try { text = fs.readFileSync(config, 'utf8'); requested ??= topString(text, 'model'); }
  catch { check('codex-config-unreadable', 'warning', '无法读取 Codex 配置。请指定实际配置文件；工具不会修改地址。'); }
  let port = 3425, portKnown = true;
  try {
    const settings = readJson(path.join(directory, 'settings.json'));
    port = settings.port ?? 3425;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  } catch (error) {
    if (error.code !== 'ENOENT') { portKnown = false; check('settings-unreadable', 'warning', '网关端口配置无法识别，本轮不探测端口。'); }
  }
  let matches = null;
  try {
    const base = new URL(configBase(text));
    matches = portKnown && base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      && !base.username && !base.password && Number(base.port || 80) === port && /^\/v1\/?$/.test(base.pathname) && !base.search && !base.hash;
  } catch {}
  report.configuration = {codexBaseMatchesLocalMagpie: matches, modelSource: model === undefined ? 'config-default' : 'user-supplied', gatewayReachable: null};
  check(matches ? 'config-points-to-magpie' : 'config-not-confirmed', matches ? 'info' : 'warning', matches
    ? '所选配置地址指向本机 Magpie；这不证明当前 Codex 进程实际使用该配置。'
    : '未确认所选配置直连本机 Magpie。检查 CODEX_HOME、profile、启动覆盖参数、自定义网关地址；地址变化后可能需要重启 Codex。');
  if (portKnown) {
    report.configuration.gatewayReachable = await probe(port);
    check(report.configuration.gatewayReachable ? 'gateway-listening' : 'gateway-not-listening', report.configuration.gatewayReachable ? 'info' : 'error', report.configuration.gatewayReachable
      ? '配置对应的本机端口可连接；未向网关发送模型请求。端口可连接不证明插件已加载。'
      : '配置对应的本机端口无法连接。检查 Magpie 是否运行，以及数据目录、监听地址或端口是否另有设置。');
  }
  let builtin = 'unknown';
  try {
    const yaml = fs.readFileSync(path.join(directory, 'plugins.yml'), 'utf8');
    if (/^\s*middleware:\s*false\s*(?:#.*)?$/m.test(yaml) || /^\s*middleware:\s*\r?\n\s+enabled:\s*false\s*(?:#.*)?$/m.test(yaml)) builtin = 'disabled';
    else if (/^\s*preset:\s*none\s*(?:#.*)?$/m.test(yaml)) builtin = 'unverified';
  } catch {}
  if (builtin === 'disabled') check('builtin-middleware-off', 'warning', '发现可能关闭 middleware 的配置。请在 Magpie 内置插件页核对实际状态；本工具不解析所有 YAML 覆盖层。');
  else check('builtin-middleware-check', 'warning', '请在 Magpie 内置插件页确认 Gateway middleware 已启用；此工具不完整解析 YAML 及其配置覆盖层。');
  for (const [index, entry] of entries.entries()) {
    const options = entry.options || {}, providers = options.providers;
    const valid = providers === undefined || (providers && typeof providers === 'object' && !Array.isArray(providers));
    const rules = valid ? Object.values(providers || {}) : [];
    const item = {id: 'filter-' + (index + 1), source: entry.spec.startsWith(COMMUNITY) ? 'community' : KNOWN.test(entry.spec) ? 'github-or-package' : 'local',
      enabled: entry.off !== true, installedVersion: null, rules: {count: rules.length, enabled: rules.filter(rule => rule?.historyFilter === true).length}, selectedRule: 'unverified'};
    const packageName = item.source === 'community' ? COMMUNITY : 'magpie-middleware-codex-history';
    const local = item.source === 'local' && path.isAbsolute(entry.spec);
    const manifestPath = local ? path.join(entry.spec, 'package.json') : path.join(directory, 'plugins', 'node_modules', ...packageName.split('/'), 'package.json');
    try {
      const manifest = readJson(manifestPath);
      if (typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)) item.installedVersion = manifest.version;
    } catch {}
    report.plugins.push(item);
    if (!valid) { check('invalid-provider-rules', 'error', item.id + ' 的 providers 格式无效，必须为对象。'); continue; }
    if (Object.entries(providers || {}).some(([key, rule]) => !key.startsWith('magpie:') || !rule || typeof rule !== 'object'
      || Array.isArray(rule) || typeof rule.historyFilter !== 'boolean'
      || (rule.preserveEncryptedInclude !== undefined && typeof rule.preserveEncryptedInclude !== 'boolean'))) {
      check('invalid-rule-fields', 'warning', item.id + ' 存在无效规则字段。键应为 magpie:供应商ID，开关使用 JSON 布尔值 true/false，不能用字符串。');
    }
    if (options.aliases !== undefined && (!options.aliases || typeof options.aliases !== 'object' || Array.isArray(options.aliases)
      || Object.values(options.aliases).some(value => typeof value !== 'string'))) {
      check('invalid-aliases', 'warning', item.id + ' 的 aliases 应为旧ID到新ID的字符串映射对象。');
    }
    if (entry.off === true) continue;
    if (!item.rules.enabled) check('no-enabled-rules', 'warning', item.id + ' 没有开启任何供应商规则，全部直通属于预期行为。');
    if (typeof requested !== 'string' || !/^[^/]+\/.+/.test(requested)) {
      item.selectedRule = 'no-provider-prefix';
      check('model-prefix-missing', 'warning', '当前待检查模型没有明确供应商前缀。请用 --model 指定该会话实际的「供应商/模型」。');
      continue;
    }
    const prefix = requested.split('/')[0], aliases = options.aliases || {};
    const id = Object.hasOwn(aliases, prefix) ? aliases[prefix] : prefix;
    const key = 'magpie:' + id;
    item.selectedRule = !Object.hasOwn(providers || {}, key) ? 'not-configured' : providers[key]?.historyFilter === true ? 'enabled' : 'disabled';
    check('selected-rule-' + item.selectedRule, item.selectedRule === 'enabled' ? 'info' : 'warning', item.selectedRule === 'enabled'
      ? '待检查模型匹配到已开启的历史过滤规则。此项只验证配置，不证明请求进入了钩子。'
      : '待检查模型的供应商规则未配置或未开启。请在 Options 核对实际供应商 ID；显示名称不能替代 ID。');
  }
  check('runtime-unobserved', 'warning', '本工具没有读取运行中网关的调用统计。请在 Magpie 插件页记录一次请求前后的调用数、失败数和最后错误；CLI 进程的零计数不能替代网关实时数据。');
  report.limits = ['配置检查不能确认过滤已执行，无法自动判定是否忘记重启 Codex。',
    '插件 Options 更改通常随后续请求重新加载，无需重启 Codex；接入地址变化可能需重启。',
    '当前中间件不能直接写文件，宿主尚未提供逐请求规则命中和清理计数的诊断接口。',
    '自动路由、fallback、其他插件改写模型及远程 Magpie 不在此配置检查的确认范围内。'];
  return report;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  const keys = {'--magpie-dir': 'directory', '--config': 'config', '--model': 'model', '--output': 'output'};
  while (args.length) {
    const arg = args.shift();
    if (arg === '--help') { console.log('node tools/diagnose.mjs [--magpie-dir PATH] [--config PATH] [--model provider/model] [--output report.json]'); return; }
    if (!keys[arg] || !args.length) throw new Error('Invalid arguments. Use --help.');
    options[keys[arg]] = args.shift();
  }
  const report = await diagnose(options), json = JSON.stringify(report, null, 2) + '\n';
  if (options.output) fs.writeFileSync(path.resolve(options.output), json, {flag: 'wx', mode: 0o600});
  console.log(json);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Diagnostic export failed. Check arguments, permissions and whether the output file already exists. No configuration was changed.'); process.exitCode = 1; });
}
