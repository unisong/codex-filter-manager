'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const {spawn, execFileSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {SERVICE, ADMIN, makeProxy, localOrigin} = require('./proxy.cjs');
const {ConfigRouter, discoverCcSwitch, readLegacyModelAliases} = require('./config.cjs');
const {createManagement} = require('./management.cjs');
const {createMagpieAdapter, discoverMagpie, detectBackend, defaultDirectory} = require('./magpie.cjs');
const {createMagpiePluginStore} = require('./magpie-plugin-store.cjs');
const {createDiagnostics, buildReport} = require('./diagnostics.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function jsonFile(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
// Returns {commandLine, createdAt} for a live PID, null when no such process exists, undefined when unknown.
function inspectProcess(pid) {
  const run = (file, args) => execFileSync(file, args,
    {encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']}).trim();
  try {
    if (process.platform === 'win32') {
      const script = "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "'; if ($p) { ConvertTo-Json -Compress "
        + "@{commandLine=[string]$p.CommandLine; createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} }";
      const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      if (!output) return null;
      const info = JSON.parse(output);
      return {commandLine: String(info.commandLine || ''), createdAt: Date.parse(info.createdAt)};
    }
    const output = run('ps', ['-o', 'args=', '-p', String(pid)]);
    return output ? {commandLine: output, createdAt: NaN} : null;
  } catch { return undefined; }
}
// alive() only proves that *some* process has the recorded PID. After a reboot or a crash Windows
// routinely hands the PID to an unrelated process, which would leave start and stop refusing forever.
function ownsProcess(record) {
  if (!record || !alive(record.pid)) return false;
  const startedAt = Date.parse(record.startedAt);
  // Uptime is reliable across suspend on Unix; on Windows the creation date below is authoritative.
  if (process.platform !== 'win32' && Number.isFinite(startedAt)
      && startedAt < Date.now() - os.uptime() * 1000 - 60000) return false;
  const info = inspectProcess(record.pid);
  if (info === undefined) return true; // Cannot verify; stay conservative and never kill or override it.
  if (info === null) return false;
  if (Number.isFinite(startedAt) && Number.isFinite(info.createdAt) && Math.abs(info.createdAt - startedAt) > 60000) return false;
  return info.commandLine.includes(path.basename(__filename)) && /(^|\s)serve(\s|$)/.test(info.commandLine);
}
function request(origin, route, token, method = 'GET', maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const req = http.request(origin + route, {method, headers: token ? {'x-filter-token': token} : {}}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > maxBytes) res.destroy(); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode !== 200) throw new Error(result.error?.message || 'Local service returned HTTP ' + res.statusCode);
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('Local service timed out.')));
    req.on('error', reject);
    req.end();
  });
}
async function health(record) {
  if (!record) return null;
  try {
    const result = await request(record.filterOrigin, ADMIN + '/health');
    // Preserve control of v1/v2 and the briefly published v3 service name.
    return [SERVICE, 'ccswitch-codex-filter'].includes(result.service)
      && result.instance === record.instance ? result : null;
  } catch { return null; }
}
function reachable(origin) {
  const url = new URL(origin);
  return new Promise(resolve => {
    const socket = net.connect({host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80)});
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1200, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
function parseArgs(argv) {
  const command = (argv.shift() || 'help').toLowerCase();
  if (!['help', 'start', 'serve', 'stop', 'status', 'diagnose'].includes(command)) throw new Error('Use start, stop, status, diagnose or serve.');
  const values = {};
  const names = new Set(['port', 'upstream', 'config', 'runtime', 'cc-db', 'backend', 'magpie-dir']);
  while (argv.length) {
    const key = argv.shift();
    if (!key.startsWith('--') || !names.has(key.slice(2)) || !argv.length) throw new Error('Invalid option: ' + key);
    values[key.slice(2)] = argv.shift();
  }
  const port = Number(values.port || 18181);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer between 1024 and 65535.');
  const configHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (values.backend && !['auto', 'ccswitch', 'magpie'].includes(values.backend)) throw new Error('Backend must be auto, ccswitch or magpie.');
  return {command, port, filterOrigin: 'http://127.0.0.1:' + port,
    configPath: path.resolve(values.config || path.join(configHome, 'config.toml')),
    runtime: path.resolve(values.runtime || path.join(__dirname, '..', '.runtime')),
    databasePath: values['cc-db'] && path.resolve(values['cc-db']),
    backend: values.backend || 'auto',
    magpieDirectory: path.resolve(values['magpie-dir'] || defaultDirectory()),
    upstream: values.upstream && localOrigin(values.upstream)};
}
function files(options) {
  return {state: path.join(options.runtime, 'service.json'), backup: path.join(options.runtime, 'routes.json'),
    log: path.join(options.runtime, 'filter.log')};
}
function routerFor(options, backup, getUpstream, log) {
  return new ConfigRouter({configPath: options.configPath, filterOrigin: options.filterOrigin,
    backupPath: backup, getUpstream, backend: options.resolvedBackend, log});
}
function routingOptions(options) {
  return {databasePath: path.resolve(options.databasePath || path.join(os.homedir(), '.cc-switch', 'cc-switch.db')),
    upstreamOverride: options.upstream || null, backend: options.backend || 'auto',
    magpieDirectory: path.resolve(options.magpieDirectory || defaultDirectory())};
}
function removeOwnState(filename, instance) {
  if (jsonFile(filename)?.instance === instance) fs.unlinkSync(filename);
}
async function serve(options) {
  const locations = files(options);
  fs.mkdirSync(options.runtime, {recursive: true});
  const diagnostics = createDiagnostics({runtime: options.runtime});
  const log = diagnostics.record;
  log('starting');
  const backend = detectBackend(options);
  options = {...options, resolvedBackend: backend};
  const discover = () => backend === 'magpie' ? discoverMagpie(options.magpieDirectory) : discoverCcSwitch(options.databasePath);
  let upstream;
  try { upstream = options.upstream || discover(); }
  catch (error) { log('startup-error', {code: error.code}); throw error; }
  if (new URL(upstream).port === String(options.port)) throw new Error('Filter port must differ from local gateway port.');
  const instance = randomBytes(12).toString('hex');
  const record = {service: SERVICE, pid: process.pid, instance, token: randomBytes(32).toString('hex'),
    filterOrigin: options.filterOrigin, configPath: options.configPath, startedAt: new Date().toISOString()};
  const previous = jsonFile(locations.state);
  if (previous) {
    if (await health(previous) || ownsProcess(previous)) throw new Error('A filter process is already running. Use status or stop.');
    fs.unlinkSync(locations.state);
  }
  // Exclusive creation serializes simultaneous starts; don't overwrite another instance.
  fs.writeFileSync(locations.state, JSON.stringify(record, null, 2), {flag: 'wx', mode: 0o600});
  let router, server, timer, stopping = false, lastError = null;
  const cleanup = () => removeOwnState(locations.state, instance);
  const shutdown = () => {
    if (stopping) return;
    // If restoration fails, keep serving rather than leaving Codex pointing at a dead port.
    router.restore();
    stopping = true;
    clearInterval(timer);
    log('stopping');
    setTimeout(() => {
      const force = setTimeout(() => server.closeAllConnections(), 10000);
      force.unref();
      server.close(() => { clearTimeout(force); cleanup(); log('stopped'); });
      server.closeIdleConnections();
    }, 50);
  };
  try {
    router = routerFor(options, locations.backup, () => upstream, log);
    const databasePath = options.databasePath || path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    const adapter = backend === 'magpie' ? createMagpieAdapter({directory:options.magpieDirectory,configPath:options.configPath,getUpstream:()=>upstream}) : null;
    const pluginStore = adapter ? createMagpiePluginStore({directory:options.magpieDirectory}) : null;
    if (pluginStore) {
      const previous = jsonFile(path.join(options.runtime, 'provider-rules.json'));
      pluginStore.install(previous?.providers || {});
    }
    const aliases = () => adapter ? new Map() : readLegacyModelAliases(path.join(options.runtime, 'legacy-model-aliases.json'), options.databasePath);
    const guard = require('./guard-service.cjs').createGuardService({runtime:options.runtime,databasePath,
      configPath:options.configPath,getUpstream:()=>upstream,adapter,log});
    const management = createManagement({databasePath, runtime: options.runtime, guard, adapter, pluginStore, log});
    server = makeProxy({getUpstream: () => upstream, token: record.token, onStop: shutdown, log, dashboard: management,guard:adapter ? undefined : guard,
      retry429: {maxAttempts: 30, baseDelayMs: 1500, maxDelayMs: 15000, budgetMs: 270000},
      getFilterPolicy: management.policy,
      requestScopedPolicy: !!adapter, getModelAliases: aliases,
      getDiagnostics: async () => buildReport({service: {running: true, backend, state: router.state,
        filterVersion: require('./proxy.cjs').FILTER_VERSION}, management, recorder: diagnostics,
        gatewayReachable: await reachable(upstream)}),
      getState: () => ({instance, backend, state: stopping ? 'stopping' : router.state, upstream,
        currentPolicy: management.policy(),
        legacyModelAliasCount: aliases().size,
        routingOptions: routingOptions(options),
        ...(pluginStore ? {integration:pluginStore.state()} : {}),
        filterOrigin: options.filterOrigin, configPath: options.configPath, lastError})});
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', resolve);
    });
    const tick = () => {
      if (stopping) return;
      try {
        upstream = options.upstream || discover();
        if (new URL(upstream).port === String(options.port)) throw new Error('Filter port conflicts with local gateway.');
        router.sync();
        lastError = null;
      } catch (error) {
        const message = error.message;
        if (lastError !== message) log('config-error', {message, code: error.code});
        lastError = message;
        router.changeState('config-error');
      }
    };
    tick();
    timer = setInterval(tick, 1000);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      try { shutdown(); }
      catch (error) { log('restore-failed', {message: error.message, code: error.code}); }
    });
    log('listening', {filterOrigin: options.filterOrigin, upstream, state: router.state});
  } catch (error) {
    log('startup-error', {code: error.code});
    clearInterval(timer);
    if (server?.listening) server.close();
    cleanup();
    throw error;
  }
}
async function status(options) {
  const record = jsonFile(files(options).state);
  const running = await health(record);
  if (running) {
    const {instance, ...publicState} = running;
    const gatewayReachable = await reachable(running.upstream);
    return {...publicState, running: true, gatewayReachable,
      ...(running.backend === 'magpie' ? {} : {ccSwitchReachable: gatewayReachable})};
  }
  const state = !record ? 'stopped' : ownsProcess(record) ? 'unresponsive' : 'stale-state';
  return {service: SERVICE, running: false, state, recoveryBackup: fs.existsSync(files(options).backup)};
}
async function diagnose(options) {
  let record, running;
  try { record = jsonFile(files(options).state); running = await health(record); } catch {}
  if (running?.filterVersion >= 33) {
    try { return (await request(record.filterOrigin, ADMIN + '/api/diagnostics', record.token, 'GET', 256 * 1024)).diagnostics; } catch {}
  }
  let backend = running?.backend || options.backend, upstream = running?.upstream || options.upstream;
  let management;
  try {
    backend = detectBackend(options);
    upstream ||= backend === 'magpie' ? discoverMagpie(options.magpieDirectory) : discoverCcSwitch(options.databasePath);
    const adapter = backend === 'magpie' ? createMagpieAdapter({directory: options.magpieDirectory, configPath: options.configPath, getUpstream: () => upstream}) : null;
    management = createManagement({runtime: options.runtime, databasePath: options.databasePath || path.join(os.homedir(), '.cc-switch', 'cc-switch.db'), adapter,
      pluginStore: adapter ? createMagpiePluginStore({directory: options.magpieDirectory}) : null});
  } catch {}
  const report = await buildReport({service: {...running, running: !!running, backend, state: running?.state || 'stopped'},
    management, recorder: createDiagnostics({runtime: options.runtime}), requestObservationAvailable: false,
    gatewayReachable: await require('./diagnostics.cjs').reachable(upstream)});
  return report;
}
async function start(options) {
  const locations = files(options);
  const running = await health(jsonFile(locations.state));
  if (running) {
    if (running.filterOrigin !== options.filterOrigin || running.configPath !== options.configPath) {
      throw new Error('Running filter has different options. Stop it before changing config/port.');
    }
    const expected = routingOptions(options);
    if (!running.routingOptions || Object.keys(expected).some(key => running.routingOptions[key] !== expected[key])
        || running.backend !== detectBackend(options)) {
      throw new Error('Running filter uses different or unknown database/upstream/backend options. Stop it before changing --backend/--magpie-dir/--cc-db/--upstream or upgrading.');
    }
    return status(options);
  }
  fs.mkdirSync(options.runtime, {recursive: true});
  const args = [__filename, 'serve', '--port', String(options.port), '--config', options.configPath, '--runtime', options.runtime];
  if (options.upstream) args.push('--upstream', options.upstream);
  if (options.databasePath) args.push('--cc-db', options.databasePath);
  if (options.backend) args.push('--backend', options.backend);
  if (options.magpieDirectory) args.push('--magpie-dir', options.magpieDirectory);
  if (fs.existsSync(locations.log) && fs.statSync(locations.log).size > 4 * 1024 * 1024) {
    fs.copyFileSync(locations.log, locations.log + '.previous');
    fs.truncateSync(locations.log, 0);
  }
  const fd = fs.openSync(locations.log, 'a');
  let child;
  try {
    child = spawn(process.execPath, args, {cwd: path.resolve(__dirname, '..'), detached: true, windowsHide: true, stdio: ['ignore', fd, fd]});
  } finally { fs.closeSync(fd); }
  let failure;
  child.on('error', error => { failure = error; });
  child.unref();
  for (let count = 0; count < 40; count++) {
    if (failure) throw failure;
    const result = await health(jsonFile(locations.state));
    if (result) {
      if (result.state === 'config-error') throw new Error('Filter started but config was not attached: ' + result.lastError + '. Use stop to restore/stop.');
      return status(options);
    }
    if (child.exitCode !== null) break;
    await delay(150);
  }
  throw new Error('Filter did not become ready. See ' + locations.log);
}
async function stop(options) {
  const locations = files(options);
  const record = jsonFile(locations.state);
  const running = await health(record);
  if (running) {
    await request(record.filterOrigin, ADMIN + '/stop', record.token, 'POST');
    for (let count = 0; count < 100; count++) {
      if (jsonFile(locations.state)?.instance !== record.instance) return {running: false, state: 'stopped', restored: running.backend !== 'magpie'};
      await delay(150);
    }
    throw new Error('Stop is still draining requests; retry status.');
  }
  if (ownsProcess(record)) {
    throw new Error('Filter process ' + record.pid + ' is alive but not responding. Refusing to kill it; retry stop after it exits.');
  }
  const backup = jsonFile(locations.backup);
  const backend = detectBackend(options);
  if (backup && backend !== 'magpie') {
    const restoreOptions = {...options, configPath: backup.configPath, filterOrigin: backup.filterOrigin};
    routerFor(restoreOptions, locations.backup, () => options.upstream || discoverCcSwitch(options.databasePath)).restore();
  }
  if (record) removeOwnState(locations.state, record.instance);
  return {running: false, state: 'stopped', restored: backend === 'magpie' ? false : !!backup};
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required (built-in SQLite and zstd).');
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    console.log('node filter.cjs start|stop|status|diagnose|serve [--port 18181] [--backend auto|ccswitch|magpie] [--magpie-dir PATH] [--upstream http://127.0.0.1:3425] [--config PATH] [--runtime PATH] [--cc-db PATH]');
  } else if (options.command === 'serve') await serve(options);
  else {
    const json = JSON.stringify(await ({start, stop, status, diagnose}[options.command])(options), null, 2);
    // Windows PowerShell 5.1 may decode child stdout using a legacy code page.
    console.log(options.command === 'diagnose' ? json.replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) : json);
  }
}
if (require.main === module) main().catch(error => { console.error('Filter: ' + error.message); process.exitCode = 1; });
module.exports = {main, parseArgs, start, stop, status, diagnose, serve, request, ownsProcess};
