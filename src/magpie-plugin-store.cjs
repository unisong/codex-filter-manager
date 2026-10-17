'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {atomicWrite} = require('./config.cjs');

// Own one local middleware entry only. Provider configuration and credentials
// remain Magpie's; the same options drive both the UI and the request hook.
function createMagpiePluginStore({directory, packagePath = path.join(__dirname, '..', 'magpie-plugin')}) {
  const filename = path.join(directory, 'plugins.json');
  const spec = path.resolve(packagePath);
  function read() {
    let raw = '';
    try { raw = fs.readFileSync(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const data = raw ? JSON.parse(raw) : {plugins: []};
    if (!Array.isArray(data.plugins)) throw new Error('Magpie plugins.json is invalid; refusing to overwrite it.');
    const matches = data.plugins.filter(p => p.spec === spec);
    if (matches.length > 1) throw new Error('Duplicate Codex history middleware entries.');
    return {raw, data, entry: matches[0], revision: createHash('sha256').update(raw).digest('hex')};
  }
  function write(before) {
    const current = read();
    if (current.raw !== before.raw) throw new Error('Magpie plugin settings changed; refresh and retry.');
    if (before.raw) atomicWrite(filename + '.codex-filter.previous', before.raw);
    atomicWrite(filename, JSON.stringify(before.data, null, 2) + '\n');
  }
  function aliases() {
    const data = JSON.parse(fs.readFileSync(path.join(directory, 'providers.json'), 'utf8'));
    const result = Object.create(null);
    for (const p of data.providers || []) for (const old of p.was || []) result[old] = p.id;
    return result;
  }
  function install(initialRules = {}) {
    if (!fs.existsSync(path.join(spec, 'history.middleware.js'))) throw new Error('Magpie history middleware package is missing.');
    const before = read();
    const names = aliases();
    if (!before.entry) {
      const providers = Object.fromEntries(Object.entries(initialRules).filter(([id]) => id.startsWith('magpie:')));
      before.data.plugins.push({spec, options: {providers, aliases: names}});
      write(before);
    } else if (JSON.stringify(before.entry.options?.aliases || {}) !== JSON.stringify(names)) {
      before.entry.options = {...before.entry.options, aliases: names};
      write(before);
    }
  }
  return {install,
    rules() {
      const before = read();
      const providers = before.entry?.options?.providers || {};
      if (!providers || typeof providers !== 'object' || Array.isArray(providers)) throw new Error('Magpie history filter rules are invalid.');
      return {...before, data: {version: 1, providers}};
    },
    update(providers, revision) {
      const before = read();
      if (before.revision !== revision) throw new Error('Magpie plugin settings changed; refresh and retry.');
      if (!before.entry) throw new Error('Magpie history middleware is not installed.');
      before.entry.options = {...before.entry.options, providers, aliases: aliases()};
      write(before);
    },
    state() {
      const {entry} = read();
      return {mode: 'magpie-plugin', installed: !!entry, enabled: !!entry && entry.off !== true,
        automaticProtection: false, modifiesCodexConfig: false};
    }
  };
}

module.exports = {createMagpiePluginStore};
