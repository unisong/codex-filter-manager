import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import '../history/page/settings.js';
import {atomic, fail} from './engine.mjs';

const settings = globalThis.HistorySettings;
const normalize = value => path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
// Only the two filter switches and rule aliases cross the browser boundary.
// Unknown options, credentials and other plugins are retained on disk only.
function publicOptions(value) {
  settings.validate(value);
  return {providers: Object.fromEntries(Object.entries(value.providers || {}).filter(([k]) => k.startsWith('magpie:'))
    .map(([k, v]) => [k, Object.fromEntries(['historyFilter', 'preserveEncryptedInclude']
      .filter(field => Object.hasOwn(v, field)).map(field => [field, v[field]]))])), aliases: value.aliases || {}};
}
export function createHistoryOptions({magpieDirectory = path.join(os.homedir(), '.config', 'magpie'),
  packageRoot = fileURLToPath(new URL('../', import.meta.url))} = {}) {
  const file = path.join(magpieDirectory, 'plugins.json');
  function read() {
    let raw, config;
    try { raw = fs.readFileSync(file, 'utf8'); config = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch { throw fail('无法读取 Magpie 插件配置。请确认插件已安装；原生过滤设置页仍可独立使用。', 503); }
    if (!Array.isArray(config.plugins)) throw fail('Magpie 插件列表格式异常，未修改配置。', 503);
    const own = config.plugins.filter(entry => typeof entry.spec === 'string' && (
      normalize(entry.spec) === normalize(packageRoot)
      || /^magpie-model-workbench(?:@[^/]+)?$/.test(entry.spec)
      || /^github:unisong\/magpie-model-workbench(?:#.*)?$/.test(entry.spec)));
    if (own.length !== 1) throw fail('无法唯一确定本工作台的安装项，未修改配置。请在 Magpie 原生过滤设置页操作。', 409);
    settings.validate(own[0].options || {});
    return {raw, config, entry: own[0]};
  }
  function get() {
    const {entry} = read();
    let names = [];
    try {
      const data = JSON.parse(fs.readFileSync(path.join(magpieDirectory, 'providers.json'), 'utf8'));
      // Magpie keeps deleted providers as hidden tombstones in providers.json.
      // They are neither selectable nor valid filter targets, so do not surface
      // them in the current-provider list. A saved rule, if any, is still added
      // by HistorySettings.rows as an explicitly missing rule.
      names = (Array.isArray(data.providers) ? data.providers : [])
        .filter(p => p && p.hidden !== true && typeof p.id === 'string')
        .map(p => ({id: p.id, name: typeof p.name === 'string' ? p.name : p.id}));
    } catch {}
    return {options: publicOptions(entry.options || {}), providers: names, enabled: !entry.off};
  }
  function save({base, draft}) {
    // Reject any attempt to edit non-filter fields through this endpoint.
    if (JSON.stringify(publicOptions(base)) !== JSON.stringify(base)
        || JSON.stringify(publicOptions(draft)) !== JSON.stringify(draft)) throw fail('仅允许修改历史过滤开关。');
    const {raw, config, entry} = read();
    if (JSON.stringify(base.aliases) !== JSON.stringify(draft.aliases)) throw fail('此页面不编辑别名，请使用 Magpie Options。');
    let next;
    try { next = settings.merge(base, draft, entry.options || {}); }
    catch { throw fail('其他窗口修改了同一规则或别名，本次未覆盖。请撤销修改并刷新后重试。', 409); }
    if (JSON.stringify(next) === JSON.stringify(entry.options || {})) return get();
    entry.options = next;
    if (fs.readFileSync(file, 'utf8') !== raw) throw fail('插件配置刚刚发生变化，请刷新后重试。', 409);
    atomic(file, JSON.stringify(config, null, 2) + '\n');
    return get();
  }
  return {get, save};
}
