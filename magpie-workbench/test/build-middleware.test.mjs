import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {combineMiddleware} from '../server/middleware.mjs';

test('live rebuild keeps protection and probe identity; release build excludes both', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'middleware-build-'));
  try {
    for (const dir of ['server', 'tools', 'history']) fs.mkdirSync(path.join(root, dir));
    for (const file of ['server/middleware.mjs', 'tools/build-middleware.mjs',
      'history/codex-history.middleware.js', 'history/PROVENANCE.json', 'history/portable-web-search.mjs']) {
      fs.copyFileSync(new URL('../' + file, import.meta.url), path.join(root, file));
    }
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const target = path.join(root, 'workbench.middleware.js');
    fs.writeFileSync(target, combineMiddleware(`// Generated locally. Test gate.
const holds={'demo/model':true};
const bypass='probe/local-only/';
export function onRequest(body,ctx){
 if(body.model.startsWith(bypass))return {...body,model:body.model.slice(bypass.length)};
 if(holds[body.model])ctx.reject(409,'paused');
}
`));
    const build = (...args) => spawnSync(process.execPath, ['tools/build-middleware.mjs', ...args], {cwd: root, encoding: 'utf8'});
    const live = build('--preserve-gate');
    assert.equal(live.status, 0, live.stderr);
    const module = await import(pathToFileURL(target).href);
    let rejected;
    module.onRequest({model: 'demo/model'}, {reject: code => { rejected = code; }});
    assert.equal(rejected, 409);
    assert.equal(module.onRequest({model: 'probe/local-only/demo/model'}, {}).model, 'demo/model');
    assert.equal(typeof module.onProvider, 'function');
    const release = build();
    assert.equal(release.status, 0, release.stderr);
    const clean = fs.readFileSync(target, 'utf8');
    assert.ok(!clean.includes('probe/local-only') && !clean.includes("'demo/model':true"));
    assert.notEqual(build('--preserve-gate').status, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), clean, 'unrecognized gate must never overwrite the file');
    const optional = build('--preserve-gate-if-present');
    assert.equal(optional.status, 0, optional.stderr);
    assert.equal(fs.readFileSync(target, 'utf8'), clean, 'optional preserve builds safely without a gate');
    fs.writeFileSync(target, combineMiddleware(`// Generated locally. Test gate.
export function onRequest(body,ctx){ if(body.model==='demo/model')ctx.reject(409,'paused'); }
`));
    const preserved = build('--preserve-gate-if-present');
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.match(fs.readFileSync(target, 'utf8'), /Generated locally/);
  } finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, {recursive: true});
  }
});
