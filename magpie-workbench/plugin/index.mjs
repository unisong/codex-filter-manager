import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

let service, retry;
const directory = path.join(os.homedir(), '.config', 'magpie-model-workbench');
async function start(options) {
  service ||= import('../server/http.mjs').then(({createService}) => createService({directory,
    gateFile: fileURLToPath(new URL('../workbench.middleware.js', import.meta.url)),
    packageRoot: fileURLToPath(new URL('../', import.meta.url)),
    magpieDirectory: options.magpieDirectory, options})).then(value => { clearTimeout(retry); retry = undefined; return value; }).catch(e => {
      service = undefined;
      // A retired host may still finish an unrelated streamed reply. Wait
      // for its console address without running a second detector engine.
      if (e.code === 'EADDRINUSE' && !retry) retry = setTimeout(() => {
        retry = undefined; start(options).catch(() => {});
      }, 2000).unref();
      throw e;
    });
  return service;
}
// Magpie currently exposes custom plugin actions through its auth-method
// picker. This is a local console opener; it never authenticates a provider.
export default {id: 'model-workbench', server: async (_input, options = {}) => ({
  auth: {provider: 'model-workbench', methods: [{type: 'oauth', label: '打开 Codex 工作台（本机，无需登录）',
    async authorize() {
      const s = await start(options);
      return {url: s.openURL(), method: 'code',
        instructions: '仅需历史过滤时，无需使用本入口：直接在 Magpie 的“Codex Workbench · 历史过滤”原生页面设置，在扩展／插件页面查看运行情况即可。需要模型监测时再打开工作台；这是本机页面，无需账号、验证码或供应商登录。打开浏览器页面后可关闭此窗口，也可双击桌面“Magpie 模型工作台”。',
        callback: async () => ({type: 'failed'})};
    }}], async loader() { try { await start(options); } catch { console.error('Codex Workbench console unavailable; history middleware remains active.'); } return {}; }},
  async config(cfg) {
    // A console, reference-bank or detector error must not prevent the host
    // from loading this package's self-contained history middleware.
    try { await start(options); } catch { console.error('Codex Workbench console unavailable; history middleware remains active.'); }
    cfg.provider ??= {};
    cfg.provider['model-workbench'] = {name: 'Codex Workbench · 本机控制台', models: {}};
  },
})};
