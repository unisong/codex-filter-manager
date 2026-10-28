import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {combineMiddleware} from '../server/middleware.mjs';
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || !['--preserve-gate', '--preserve-gate-if-present'].includes(args[0]))) throw Error('Unknown build option');
const file = new URL('../workbench.middleware.js', import.meta.url);
const previous = args[0] === '--preserve-gate' ? fs.readFileSync(file, 'utf8')
  : args[0] === '--preserve-gate-if-present' && fs.readFileSync(file, 'utf8').includes('// Generated locally.') ? fs.readFileSync(file, 'utf8') : null;
let gate;
if (previous !== null) {
  const start = previous.indexOf('// Generated locally.');
  const end = previous.indexOf('\nexport function onRequest(body,ctx){', start);
  if (start < 0 || end < 0) throw Error('Cannot locate the running protection gate; nothing written');
  gate = previous.slice(start, end);
  if (gate.split('function protectionRequest(').length !== 2) throw Error('Ambiguous protection gate');
  gate = gate.replace('function protectionRequest(', 'export function onRequest(');
}
const code = combineMiddleware(gate);
const temp = new URL('./workbench.middleware.' + randomUUID() + '.tmp', file);
try {
  fs.writeFileSync(temp, code, {flag: 'wx', mode: 0o600});
  if (previous !== null && fs.readFileSync(file, 'utf8') !== previous) throw Error('Running protection gate changed; retry build');
  fs.renameSync(temp, file);
} finally {
  if (fs.existsSync(temp)) fs.unlinkSync(temp);
}
console.log(previous === null ? 'Built combined middleware; no provider rules or model holds bundled.'
  : 'Built combined middleware; existing protection gate preserved.');
