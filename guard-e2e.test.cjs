'use strict';

// Exercise the deployed composition without contacting any supplier or touching
// live settings: HTTP proxy -> guard service -> fingerprint engine -> transport.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {DatabaseSync} = require('node:sqlite');
const {makeProxy} = require('./proxy.cjs');
const {createGuardService} = require('./guard-service.cjs');
const {createGuard} = require('./guard.cjs');
const {createManagement} = require('./management.cjs');

const requested = 'gpt-6-astra', alternate = 'gpt-6-luna';
const numbers = Array.from({length:300},(_,i)=>i+1).join(',');
const frame = event => 'data: '+JSON.stringify(event)+'\n\n';
const done = (model,text) => frame({type:'response.completed',response:{model,status:'completed',
  output:[{type:'message',content:[{type:'output_text',text}]}]}});
const listen = async server => {server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;};

async function fixture(t) {
  const root=fs.realpathSync(process.env.PI_SCRATCH_DIR);
  const runtime=fs.mkdtempSync(path.join(root,'guard-e2e-'));
  const databasePath=path.join(runtime,'fixture.db'),configPath=path.join(runtime,'config.toml');
  const db=new DatabaseSync(databasePath);
  db.exec("CREATE TABLE providers(id TEXT,name TEXT,app_type TEXT,is_current INTEGER,settings_config TEXT,sort_index INTEGER); CREATE TABLE proxy_config(app_type TEXT,auto_failover_enabled INTEGER); INSERT INTO proxy_config VALUES('codex',0)");
  db.prepare('INSERT INTO providers VALUES(?,?,?,?,?,0)').run('provider','Test Provider','codex',1,
    JSON.stringify({config:'model_provider="fixture"\n[model_providers.fixture]\nbase_url="https://fixture.invalid/v1"'}));
  fs.writeFileSync(configPath,'model="gpt-6-astra"\nmodel_reasoning_effort="high"');
  const events=[];let mismatch=false,businessMismatch=false;
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));
    const isProbe=body.instructions?.includes('number-generation');
    events.push(isProbe?'probe':'project');
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(isProbe) {
      assert.doesNotMatch(JSON.stringify(body),/PRIVATE_PROJECT/);
      res.end(done(requested,numbers));
    } else {
      assert.equal(body.input,'PRIVATE_PROJECT');
      res.write(frame({type:'response.output_item.added',item:{type:'function_call',name:'exec',arguments:'PROJECT_TOOL_OUTPUT'}}));
      res.end(done(businessMismatch?alternate:requested,'PROJECT_RESULT'));
    }
  });
  const upstreamOrigin=await listen(upstream);
  const engineFactory=options=>createGuard({...options,analyze:()=>({used_outputs:3,
    diagnostics:Array.from({length:3},()=>({accepted:true})),
    results:[{model:mismatch?alternate:requested,probability:.96},{model:mismatch?requested:alternate,probability:.02}]})});
  const options={runtime,databasePath,configPath,getUpstream:()=>upstreamOrigin,engineFactory};
  let guard,manager,proxy,url;
  async function launch() {
    guard=createGuardService(options);manager=createManagement({runtime,databasePath,guard});
    proxy=makeProxy({getUpstream:()=>upstreamOrigin,guard,dashboard:manager,token:'fixture-token'});
    url=await listen(proxy);
  }
  const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
  await launch();
  t.after(async()=>{await close(proxy);await close(upstream);db.close();assert.equal(path.dirname(fs.realpathSync(runtime)),root);fs.rmSync(runtime,{recursive:true,force:true});});
  return {events,db,get guard(){return guard;},
    state:async()=>{const response=await fetch(url+'/__codex_filter__/api/state',{headers:{'x-filter-token':'fixture-token'}});assert.equal(response.status,200);return (await response.json()).guard;},
    configure:settings=>manager.handle('PUT','/guard/providers/provider',{...settings,revision:manager.state().guard.settingsRevision}),
    mismatch:value=>{mismatch=value;},businessMismatch:value=>{businessMismatch=value;},
    restart:async()=>{await close(proxy);await launch();},
    call:async()=>{const response=await fetch(url+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:requested,reasoning:{effort:'high'},stream:true,input:'PRIVATE_PROJECT'})});
      return {status:response.status,body:await response.text()};}
  };
}

test('real proxy composition verifies before forwarding, caches passes and rechecks after restart',async t=>{
  const f=await fixture(t);f.configure({enabled:true,ttlSeconds:600});
  const first=await f.call();assert.equal(first.status,200);assert.match(first.body,/PROJECT_RESULT/);
  assert.deepEqual(f.events,['probe','probe','probe','project']);
  const firstHistory=(await f.state()).history;assert.equal(firstHistory.length,1);assert.equal(firstHistory[0].status,'passed');assert.equal(firstHistory[0].source,'automatic');
  assert.equal((await f.call()).status,200);assert.equal(f.events.filter(x=>x==='probe').length,3);
  assert.deepEqual((await f.state()).history,firstHistory);
  await f.restart();assert.equal((await f.call()).status,200);assert.equal(f.events.filter(x=>x==='probe').length,6);
  const afterRestart=await f.state();assert.equal(afterRestart.history.length,2);assert.deepEqual(afterRestart.history[1],firstHistory[0]);assert.notEqual(afterRestart.history[0].id,firstHistory[0].id);
});
test('confirmed fingerprint mismatch blocks projects across restart; clear triggers a fresh verification',async t=>{
  const f=await fixture(t);f.configure({enabled:true,ttlSeconds:600});f.mismatch(true);
  const rejected=await f.call();assert.equal(rejected.status,409);assert.match(rejected.body,/guard_blocked/);
  assert.equal(f.events.length,6);assert.ok(f.events.every(x=>x==='probe'));
  const blockedHistory=(await f.state()).history;assert.equal(blockedHistory.length,1);assert.equal(blockedHistory[0].status,'blocked');
  await f.restart();assert.equal((await f.call()).status,409);assert.equal(f.events.length,6);
  assert.deepEqual((await f.state()).history,blockedHistory);
  f.mismatch(false);f.guard.clear(f.guard.snapshot().records[0].key);
  assert.deepEqual((await f.state()).history,blockedHistory);
  assert.equal((await f.call()).status,200);assert.equal(f.events.filter(x=>x==='probe').length,9);
  assert.deepEqual((await f.state()).history.map(x=>x.status),['passed','blocked']);
});
test('real cancellation on response-model mismatch withholds tool calls and persists the latch',async t=>{
  const f=await fixture(t);f.configure({enabled:true,ttlSeconds:600});f.businessMismatch(true);
  const rejected=await f.call();assert.equal(rejected.status,409);assert.doesNotMatch(rejected.body,/PROJECT_TOOL_OUTPUT|PROJECT_RESULT/);
  assert.equal(f.guard.snapshot().records[0].status,'blocked');
  const history=(await f.state()).history;assert.deepEqual(history.map(x=>[x.status,x.source]),[['blocked','response'],['passed','automatic']]);
  const count=f.events.length;await f.restart();assert.equal((await f.call()).status,409);assert.equal(f.events.length,count);
  assert.deepEqual((await f.state()).history,history);
});
