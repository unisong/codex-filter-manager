'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {topString, providerBase, sameEndpoint} = require('./config.cjs');

const workbenchMessage = 'Magpie uses the full workbench plugin. Load magpie-workbench/ in Magpie, then open magpie-workbench/Open.bat. The root service no longer installs a Magpie hook and will not change its Codex base_url.';
function detectBackend(options) {
  if (options.backend === 'magpie') return 'magpie';
  try {
    const text = fs.readFileSync(options.configPath, 'utf8');
    if (topString(text, 'model_provider') === 'magpie') return 'magpie';
    const base = providerBase(text);
    let port = 3425;
    try { port = JSON.parse(fs.readFileSync(path.join(options.magpieDirectory || path.join(os.homedir(), '.config', 'magpie'), 'settings.json'), 'utf8')).port || port; } catch {}
    const origin = 'http://127.0.0.1:' + port;
    if (base && sameEndpoint(base.url, origin)) return 'magpie';
    try {
      const backup = JSON.parse(fs.readFileSync(path.join(options.runtime, 'routes.json'), 'utf8'));
      const original = backup.routes?.find(([id]) => id === base?.provider)?.[1]?.originalUrl;
      if (original && sameEndpoint(original, origin)) return 'magpie';
    } catch {}
  } catch {}
  return 'ccswitch';
}
function serviceBackend(options) {
  if (detectBackend(options) === 'magpie') throw new Error(workbenchMessage);
  return 'ccswitch';
}
module.exports = {detectBackend, serviceBackend, workbenchMessage};
