import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {atomic, fail} from './engine.mjs';

export function localGateway(value) {
  let u;
  try { u = new URL(value); } catch { throw fail('网关地址格式无效。'); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
      || u.username || u.password || u.search || u.hash || !['', '/', '/v1', '/v1/'].includes(u.pathname)) {
    throw fail('只支持本机 HTTP Magpie 网关，例如 http://127.0.0.1:3425；不要填写供应商地址。');
  }
  return u.origin;
}
export function createGateway({directory, magpieDirectory = path.join(os.homedir(), '.config', 'magpie'), options = {}}) {
  const file = path.join(directory, 'connection.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw fail('网关连接配置损坏，请修复 connection.json。'); }
  function discover() {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(path.join(magpieDirectory, 'settings.json'), 'utf8')); } catch {}
    const port = settings.port || 3425;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('Magpie 网关端口无效。');
    return 'http://127.0.0.1:' + port;
  }
  function get() { return {url: localGateway(config.url || options.gatewayUrl || discover()), key: config.key || options.gatewayKey || ''}; }
  function save(input) {
    const next = {url: localGateway(input.url)};
    if (typeof input.key !== 'string' || input.key.length > 4096 || /[\r\n]/.test(input.key)) throw fail('网关 Key 格式无效。');
    next.key = input.clearKey ? '' : (input.key || config.key || '');
    atomic(file, JSON.stringify(next, null, 2)); config = next;
  }
  function routeVersion() {
    const h = createHash('sha256'); h.update(JSON.stringify(get()));
    for (const name of ['providers.json', 'settings.json', 'plugins.yml']) {
      try { h.update(fs.readFileSync(path.join(magpieDirectory, name))); } catch { h.update('missing:' + name); }
    }
    return h.digest('hex');
  }
  async function models() {
    const {url, key} = get();
    let response;
    try { response = await fetch(url + '/v1/models', {headers: key ? {authorization: 'Bearer ' + key} : {},
      redirect: 'error', signal: AbortSignal.timeout(10000)}); }
    catch { throw fail('无法连接本机 Magpie 网关，请确认 Magpie 正在运行及端口正确。', 503); }
    if (!response.ok) throw fail('读取模型列表失败（HTTP ' + response.status + '）。请检查网关 Key 与网关状态。', 503);
    const raw = await response.text();
    if (raw.length > 4 * 1024 * 1024) throw fail('网关模型列表过大。', 503);
    let data;
    try { data = JSON.parse(raw); } catch { throw fail('网关没有返回有效模型列表。', 503); }
    if (!Array.isArray(data.data)) throw fail('网关模型列表格式异常。', 503);
    return [...new Set(data.data.map(m => m.id).filter(id => typeof id === 'string'
      && /^[^/\s]+\/.+/.test(id) && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id)
      && !id.startsWith('workbench-probe/')))].sort();
  }
  return {get, save, routeVersion, models, public: () => ({url: get().url, hasKey: !!get().key})};
}
