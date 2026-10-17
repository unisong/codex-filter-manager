import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export async function consoleURL(directory = path.join(os.homedir(), '.config', 'magpie-model-workbench')) {
  let runtime;
  try { runtime = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8')); }
  catch { throw Error('工作台尚未启动。请先打开 Magpie，并确认 Model Workbench 插件已启用。'); }
  const url = new URL(runtime.origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('工作台运行信息无效。');
  let response;
  try { response = await fetch(url.origin + '/api/open', {method: 'POST',
    headers: {authorization: 'Bearer ' + runtime.control}, signal: AbortSignal.timeout(3000), redirect: 'error'}); }
  catch { throw Error('工作台进程未运行。请检查 Magpie 插件状态或重启 Magpie。'); }
  if (!response.ok) throw Error('工作台未确认访问权限，请重启 Magpie 后重试。');
  const result = await response.json();
  const target = new URL(result.url);
  if (target.origin !== url.origin || !/^#open=[a-f0-9]{64}$/.test(target.hash)) throw Error('工作台返回的打开地址无效。');
  return result.url;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const url = await consoleURL();
    // No shell interpolation: pass the URL as one argument.
    const child = process.platform === 'win32'
      ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {detached: true, stdio: 'ignore', windowsHide: true})
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {detached: true, stdio: 'ignore'});
    child.unref();
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
