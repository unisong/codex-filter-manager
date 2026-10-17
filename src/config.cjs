'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {localOrigin} = require('./proxy.cjs');

function atomicWrite(filename, text) {
  const pause = attempt => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(20 + attempt * 15, 120));
  const transient = error => ['EPERM', 'EBUSY', 'EACCES', 'ENOENT'].includes(error?.code);
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  const temp = filename + '.filter-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.tmp';
  let failure = null;
  try {
    fs.writeFileSync(temp, text, {flag: 'wx', mode: 0o600});
    // Windows virus scanners and backup agents can briefly share-lock the
    // destination. Retry only those transient sharing errors; real disk or
    // permission failures still surface immediately.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temp, filename); break; }
      catch (error) {
        if (!transient(error) || attempt >= 9) throw error;
        pause(attempt);
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (fs.existsSync(temp)) {
      for (let attempt = 0; ; attempt++) {
        try { fs.unlinkSync(temp); break; }
        catch (error) {
          if (!transient(error) || attempt >= 9) {
            if (!failure) throw error;
            break;
          }
          pause(attempt);
        }
      }
    }
  }
}

function unquote(value) {
  return value.startsWith("'") ? value.slice(1, -1) : JSON.parse(value);
}

function topString(text, name) {
  const top = text.replace(/^\uFEFF/, '').split(/^\s*\[/m)[0];
  const match = top.match(new RegExp('^\\s*' + name + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|\'[^\']*\')\\s*(?:#.*)?$', 'm'));
  if (!match) return undefined;
  try { return unquote(match[1]); } catch { return undefined; }
}

function sectionProvider(line) {
  const match = line.match(/^\s*\[\s*model_providers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]\s*(?:#.*)?$/);
  return match ? (/^["']/.test(match[1]) ? unquote(match[1]) : match[1]) : null;
}

function providerBase(text, requestedProvider) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let provider = requestedProvider;
  if (!provider) {
    for (const line of lines) {
      if (/^\s*\[/.test(line)) break;
      const match = line.match(/^\s*model_provider\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
      if (match) provider = unquote(match[1]);
    }
  }
  if (!provider) return null;
  let inProvider = false;
  const found = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inProvider = sectionProvider(line) === provider;
    } else if (inProvider) {
      const match = line.match(/^(\s*base_url\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/);
      if (match) found.push({provider, line, url: unquote(match[2]), prefix: match[1], suffix: match[3]});
    }
  }
  if (found.length > 1) throw new Error('Duplicate base_url entries; refusing to edit config.');
  return found[0] || null;
}

function replaceBase(text, entry, url, originalLine) {
  const lines = text.split(/(?<=\n)/);
  let inProvider = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$/, '').replace(/^\uFEFF/, '');
    if (/^\s*\[/.test(line)) {
      inProvider = sectionProvider(line) === entry.provider;
    } else if (inProvider && line === entry.line) {
      lines[i] = (originalLine ?? entry.prefix + JSON.stringify(url) + entry.suffix)
        + (lines[i].endsWith('\r\n') ? '\r\n' : lines[i].endsWith('\n') ? '\n' : '');
      return lines.join('');
    }
  }
  throw new Error('Provider config changed; refusing to overwrite it.');
}

function sameEndpoint(url, origin) {
  try {
    const left = new URL(url), right = new URL(origin);
    return left.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(left.hostname)
      && !left.username && !left.password && Number(left.port || 80) === Number(right.port || 80);
  } catch { return false; }
}

function rewriteOrigin(url, origin) {
  const result = new URL(url), target = new URL(origin);
  result.protocol = target.protocol;
  result.host = target.host;
  return result.href;
}

function discoverCcSwitch(databasePath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db')) {
  if (!fs.existsSync(databasePath)) return 'http://127.0.0.1:15721';
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(databasePath, {readOnly: true});
  try {
    const row = db.prepare("SELECT listen_address, listen_port FROM proxy_config WHERE app_type = 'codex'").get();
    if (!row) throw new Error('CC Switch Codex proxy configuration not found.');
    const address = row.listen_address;
    const host = ['0.0.0.0', '127.0.0.1', 'localhost'].includes(address) ? '127.0.0.1'
      : ['::', '::1'].includes(address) ? '[::1]' : address;
    return localOrigin('http://' + host + ':' + Number(row.listen_port));
  } finally { db.close(); }
}

// Providers are passthrough until the user saves an explicit local rule.
function providerPolicy(config, override) {
  const pass = reason => ({filter: false, mode: 'passthrough', reason, provider: 'unknown'});
  try {
    if (typeof config !== 'string') return pass('base-url-unidentified');
    // The narrow line parser cannot safely interpret TOML multiline strings.
    // Prefer no filtering over accidentally treating an embedded example as routing.
    if (/"""|'''/.test(config)) return pass('complex-toml-unidentified');
    const entry = providerBase(config);
    if (!entry) return pass('base-url-unidentified');
    const url = new URL(entry.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return pass('base-url-unidentified');
    if (override && ['historyFilter', 'preserveEncryptedInclude', 'stripResponsesLiteHeader'].every(k => typeof override[k] === 'boolean')) {
      return {filter: override.historyFilter, mode: override.historyFilter ? 'filtering'
        : override.stripResponsesLiteHeader ? 'compatibility' : 'passthrough', reason: 'user-override',
        provider: url.hostname, preserveEncryptedInclude: override.preserveEncryptedInclude,
        stripResponsesLiteHeader: override.stripResponsesLiteHeader};
    }
    const host = url.hostname.toLowerCase();
    // Require valid DNS labels as well as a dot boundary (not suffix lookalikes).
    if (host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return pass('base-url-unidentified');
    return pass('not-configured');
  } catch { return pass('base-url-unidentified'); }
}

// One read-only snapshot per request. Project only config TOML, never auth/API-key fields.
function readFilterPolicy(databasePath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db'), overrides = {}) {
  const pass = reason => ({filter: false, mode: 'passthrough', reason, provider: 'unknown'});
  if (!fs.existsSync(databasePath)) return pass('database-missing');
  let db;
  try {
    const {DatabaseSync} = require('node:sqlite');
    db = new DatabaseSync(databasePath, {readOnly: true});
    db.exec('BEGIN');
    const proxy = db.prepare("SELECT auto_failover_enabled FROM proxy_config WHERE app_type = 'codex'").get();
    if (!proxy || proxy.auto_failover_enabled !== 0) return pass('auto-failover-or-unknown');
    const rows = db.prepare("SELECT id, json_extract(settings_config, '$.config') AS config FROM providers WHERE app_type = 'codex' AND is_current = 1").all();
    if (rows.length !== 1 || typeof rows[0].config !== 'string') return pass('current-provider-unidentified');
    return providerPolicy(rows[0].config, Object.hasOwn(overrides, rows[0].id) ? overrides[rows[0].id] : undefined);
  } catch { return pass('database-or-config-unreadable'); }
  finally { db?.close(); }
}

// Explicit downgrade-only mappings. Never strip arbitrary slash prefixes or
// map one real model to a different one. Unknown/new schemas disable this shim.
function readLegacyModelAliases(filename, databasePath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db')) {
  const aliases = new Map();
  let db;
  try {
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (config.enabled !== true || config.databaseVersion !== 19 || !Array.isArray(config.aliases)) return aliases;
    const {DatabaseSync} = require('node:sqlite');
    db = new DatabaseSync(databasePath, {readOnly: true});
    if (db.prepare('PRAGMA user_version').get().user_version !== config.databaseVersion) return aliases;
    for (const [from, to] of config.aliases) {
      if (typeof from === 'string' && typeof to === 'string'
          && /^ccs-[a-z0-9-]+\/[^/\s]+$/.test(from) && to === from.slice(from.indexOf('/') + 1)) aliases.set(from, to);
    }
  } catch { return new Map(); }
  finally { db?.close(); }
  return aliases;
}

class ConfigRouter {
  constructor({configPath, backupPath, filterOrigin, getUpstream, backend = 'ccswitch', log = () => {}}) {
    this.configPath = path.resolve(configPath);
    this.backupPath = backupPath;
    this.filterOrigin = localOrigin(filterOrigin);
    this.getUpstream = getUpstream;
    this.log = log;
    this.waitingState = 'waiting-for-' + backend;
    if (backend !== 'ccswitch') throw new Error('ConfigRouter only supports CC Switch; load magpie-workbench/ in Magpie.');
    this.state = this.waitingState;
    this.routes = new Map();
    if (fs.existsSync(backupPath)) {
      const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      if (backup.configPath !== this.configPath || backup.filterOrigin !== this.filterOrigin || backup.version !== 1) {
        throw new Error('Existing address backup belongs to another config/port/version. Restore it before changing options.');
      }
      this.routes = new Map(backup.routes);
    }
  }
  save() {
    atomicWrite(this.backupPath, JSON.stringify({version: 1, configPath: this.configPath,
      filterOrigin: this.filterOrigin, routes: [...this.routes]}, null, 2));
  }
  changeState(state) {
    if (this.state !== state) { this.state = state; this.log('config-state', {state}); }
  }
  sync() {
    if (!fs.existsSync(this.configPath)) { this.changeState('waiting-for-codex-config'); return; }
    const text = fs.readFileSync(this.configPath, 'utf8');
    const entry = providerBase(text);
    if (!entry) { this.changeState('waiting-for-supported-provider'); return; }
    if (sameEndpoint(entry.url, this.filterOrigin)) {
      if (this.routes.get(entry.provider)?.filteredUrl !== entry.url) {
        throw new Error('Filter URL found without its original-address backup; refusing to guess.');
      }
      this.changeState('filtering');
      return;
    }
    const upstream = this.getUpstream();
    if (!sameEndpoint(entry.url, upstream)) { this.changeState(this.waitingState); return; }
    if (new URL(entry.url).search || new URL(entry.url).hash) {
      throw new Error('Query strings and fragments in provider base_url are not supported.');
    }
    const filteredUrl = rewriteOrigin(entry.url, this.filterOrigin);
    const changed = replaceBase(text, entry, filteredUrl);
    const filteredLine = providerBase(changed).line;
    // Recovery info is saved before redirecting Codex; auth and full config are never copied.
    this.routes.set(entry.provider, {originalUrl: entry.url, originalLine: entry.line, filteredUrl, filteredLine});
    this.save();
    if (fs.readFileSync(this.configPath, 'utf8') !== text) return;
    atomicWrite(this.configPath, changed);
    this.changeState('filtering');
    this.log('config-attached', {provider: entry.provider});
  }
  restore() {
    if (!fs.existsSync(this.configPath)) return;
    let text = fs.readFileSync(this.configPath, 'utf8');
    const original = text;
    for (const [provider, route] of this.routes) {
      const entry = providerBase(text, provider);
      if (entry?.url === route.filteredUrl) {
        text = replaceBase(text, entry, route.originalUrl,
          entry.line === route.filteredLine ? route.originalLine : undefined);
      }
    }
    if (text !== original) {
      if (fs.readFileSync(this.configPath, 'utf8') !== original) throw new Error('Config changed while restoring; retry Stop.');
      atomicWrite(this.configPath, text);
    }
    this.changeState('restored');
  }
}

module.exports = {atomicWrite, topString, providerBase, replaceBase, sameEndpoint, discoverCcSwitch, providerPolicy, readFilterPolicy, readLegacyModelAliases, ConfigRouter};
