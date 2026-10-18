import http from 'node:http';
import fs from 'node:fs';
const productVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createEngine, atomic, fail} from './engine.mjs';
import {createGateway} from './gateway.mjs';
import {createHistoryOptions} from './history-options.mjs';
import {createCurrentModel} from './current-model.mjs';
import updaterModule from './updater.cjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const token = () => randomBytes(32).toString('hex');
export async function createService({directory, gateFile, magpieDirectory, packageRoot, options = {}, probe, tickMs, wait, onClose}) {
  const gateway = createGateway({directory, magpieDirectory, options});
  let engine;
  const historyOptions = createHistoryOptions({magpieDirectory, packageRoot});
  const currentModel = createCurrentModel({gateway: gateway.get, magpieDirectory, history: () => engine.snapshot().history});
  const updater = updaterModule.createUpdater({root: packageRoot || fileURLToPath(new URL('../', import.meta.url)),
    directory, currentVersion: productVersion, mode: 'magpie', helper: fileURLToPath(new URL('../tools/install-update.ps1', import.meta.url))});
  let closing;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      await engine.close();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      try { const info = JSON.parse(fs.readFileSync(runFile)); if (info.pid === process.pid && info.origin === origin) fs.unlinkSync(runFile); } catch {}
      onClose?.();
    })();
    return closing;
  }
  const sessionFile = path.join(directory, 'browser-sessions.json');
  let savedSessions = {};
  try { savedSessions = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch {}
  const control = token(), opens = new Map(), sessions = new Map(Object.entries(savedSessions)
    .filter(([key, expiry]) => /^[a-f0-9]{64}$/.test(key) && Number.isFinite(expiry) && expiry > Date.now()));
  const saveSessions = () => atomic(sessionFile, JSON.stringify(Object.fromEntries(sessions)));
  let origin;
  const reply = (res, status, value) => {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(value));
  };
  async function json(req) {
    let size = 0, raw = '';
    for await (const chunk of req) { size += chunk.length; if (size > 32768) throw fail('提交内容过大。', 413); raw += chunk; }
    try { const v = JSON.parse(raw); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; }
    catch { throw fail('提交内容须为 JSON 对象。'); }
  }
  function prune() {
    const now = Date.now();
    for (const map of [opens, sessions]) for (const [k, expires] of map) if (expires < now) map.delete(k);
  }
  function openURL() {
    prune(); if (opens.size > 20) opens.delete(opens.keys().next().value);
    const key = token(); opens.set(key, Date.now() + 5 * 60000); return origin + '/#open=' + key;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host) throw fail('Host 不受信任。', 403);
      const url = new URL(req.url, origin), pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/health') return reply(res, 200, {service: 'magpie-model-workbench', version: productVersion});
      if (pathname === '/api/open' && req.method === 'POST') {
        if (!same(req.headers.authorization || '', 'Bearer ' + control)) throw fail('未授权。', 401);
        if (req.headers.origin && req.headers.origin !== origin) throw fail('来源不受信任。', 403);
        return reply(res, 200, {url: openURL()});
      }
      if (pathname.startsWith('/api/')) {
        prune();
        if (req.method !== 'GET' && req.headers.origin !== origin) throw fail('请从本机工作台提交。', 403);
        if (pathname === '/api/session' && req.method === 'POST') {
          const {key} = await json(req);
          if (!opens.has(key)) throw fail('打开链接已失效。请从桌面或 Magpie 重新打开工作台。', 401);
          opens.delete(key); const session = token(); sessions.set(session, Date.now() + 12 * 3600000); saveSessions();
          res.setHeader('Set-Cookie', 'mw_session=' + session + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200');
          return reply(res, 200, {ok: true});
        }
        const cookie = /(?:^|;\s*)mw_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        if (!sessions.has(cookie)) throw fail('请从桌面或 Magpie 入口重新打开工作台。', 401);
        if (req.method === 'GET' && pathname === '/api/updates') return reply(res, 200, updater.snapshot());
        if (req.method === 'GET' && pathname === '/api/state') return reply(res, 200, {...engine.snapshot(), connection: gateway.public(), currentModel: await currentModel()});
        if (req.method === 'GET' && pathname === '/api/models') return reply(res, 200, {models: await gateway.models()});
        if (req.method === 'GET' && pathname === '/api/filter') return reply(res, 200, historyOptions.get());
        if (req.method === 'GET' && /^\/api\/records\/[^/]+$/.test(pathname)) {
          const record = engine.record(pathname.split('/').pop()); if (!record) throw fail('记录不存在。', 404);
          return reply(res, 200, record);
        }
        if (req.method !== 'POST') throw fail('入口不存在。', 404);
        const body = await json(req);
        if (pathname === '/api/service/stop') {
          if (updater.busy) throw fail('正在准备更新，请等待完成后再关闭。', 409);
          // Stop schedules durably; keep the host and published protection/history middleware intact.
          engine.schedule(undefined, 'stop');
          reply(res, 200, {stopping: true});
          setTimeout(() => close().catch(() => {}), 50);
          return;
        }
        if (pathname === '/api/updates/check') {
          if (updater.busy) throw fail('正在准备更新，请稍后再检查。', 409);
          updater.check().catch(() => {}); return reply(res, 200, updater.snapshot());
        }
        if (pathname === '/api/updates/install') {
          try { return reply(res, 200, updater.install(body.tag)); }
          catch (error) { throw fail(error.message, 409); }
        }
        if (pathname === '/api/filter') {
          if (engine.snapshot().targets.some(t => t.running)) throw fail('请先等待检测结束或取消检测，再保存过滤规则，避免 Magpie 重载中断取样。', 409);
          return reply(res, 200, historyOptions.save(body));
        }
        if (pathname === '/api/targets') {
          // New/edited targets must exist in the current gateway model list.
          if (!(await gateway.models()).includes(body.model)) throw fail('所选模型不在当前 Magpie 模型列表中，请刷新后重选。');
          engine.update(body);
        } else if (pathname === '/api/check') engine.start(body.id);
         else if (pathname === '/api/schedule') engine.schedule(body.id, body.action);
        else if (pathname === '/api/action') engine.action(body.id, body.action);
        else if (pathname === '/api/budget') engine.budget(body.limit);
        else if (pathname === '/api/connection') gateway.save(body);
        else throw fail('入口不存在。', 404);
        return reply(res, 200, {ok: true});
      }
      if (req.method !== 'GET') throw fail('入口不存在。', 404);
      if (pathname === '/history-settings.js') {
        res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache'});
        return res.end(fs.readFileSync(new URL('../history/page/settings.js', import.meta.url)));
      }
      const files = {'/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
        '/style.css': ['style.css', 'text/css'], '/workbench-theme.css': ['workbench-theme.css', 'text/css'],
        '/current-selection.js': ['current-selection.js', 'text/javascript'], '/service-controls.js': ['service-controls.js', 'text/javascript'], '/icon.svg': ['icon.svg', 'image/svg+xml']};
      const asset = files[pathname]; if (!asset) throw fail('入口不存在。', 404);
      res.writeHead(200, {'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-cache'});
      res.end(fs.readFileSync(path.join(webRoot, asset[0])));
    } catch (e) { if (!res.headersSent) reply(res, e.status || 500, {error: e.status ? e.message : '本地服务处理失败，请检查目录权限或重新打开。'}); else res.end(); }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  // Reuse the console address and browser sessions when Magpie reloads the
  // Bun host after an Options save. No credentials are sent to the browser.
  const addressFile = path.join(directory, 'console-address.json');
  let previousPort = 0;
  try { previousPort = JSON.parse(fs.readFileSync(addressFile, 'utf8')).port; } catch {}
  if (!Number.isInteger(previousPort) || previousPort < 1024 || previousPort > 65535) previousPort = 0;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(previousPort, '127.0.0.1', resolve); });
    // Acquire the listening address BEFORE touching state or rotating the
    // probe secret. A separate Magpie CLI host may inspect this same plugin.
    // It must not overwrite the live host's gate or interrupted-job records.
    engine = createEngine({directory, gateFile, gateway: gateway.get, routeVersion: gateway.routeVersion, probe, tickMs, wait});
    atomic(addressFile, JSON.stringify({port: server.address().port}));
  } catch (error) {
    await engine?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    throw error;
  }
  origin = 'http://127.0.0.1:' + server.address().port;
  const runFile = path.join(directory, 'runtime.json');
  atomic(runFile, JSON.stringify({origin, control, pid: process.pid, packageRoot, service: 'magpie-model-workbench'}));
  return {origin, openURL, engine, close};
}
