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
  const events=[],probeModels=[];let mismatch=false,businessMismatch=false,probeFailure=null;
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));
    const isProbe=body.instructions?.includes('整数选择任务');
    events.push(isProbe?'probe':'project');
    if(isProbe) {
      probeModels.push({model:body.model,effort:body.reasoning?.effort || 'default'});
      if(probeFailure) {
        res.writeHead(probeFailure.status,{'content-type':'application/json'});
        res.end(JSON.stringify(probeFailure.body));return;
      }
    }
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
  return {events,probeModels,db,get guard(){return guard;},
    state:async()=>{const response=await fetch(url+'/__codex_filter__/api/state',{headers:{'x-filter-token':'fixture-token'}});assert.equal(response.status,200);return (await response.json()).guard;},
    configure:settings=>manager.handle('PUT','/guard/providers/provider',{...settings,revision:manager.state().guard.settingsRevision}),
    mismatch:value=>{mismatch=value;},businessMismatch:value=>{businessMismatch=value;},
    probeFailure:value=>{probeFailure=value;},
    restart:async()=>{await close(proxy);await launch();},
    call:async(overrides={})=>{const response=await fetch(url+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:requested,reasoning:{effort:'high'},stream:true,input:'PRIVATE_PROJECT',...overrides})});
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

test('unsupported upstream model fails closed once, survives retries and restart, and manual model choice remains separate',async t=>{
  const f=await fixture(t);f.configure({enabled:true,ttlSeconds:1800});
  f.probeFailure({status:503,body:{error:{code:'model_not_found',message:'No available channel for model; PRIVATE_UPSTREAM_DETAIL'}}});
  const request={model:alternate,reasoning:{effort:'low'}};
  const rejected=await f.call(request);
  assert.equal(rejected.status,409);assert.match(rejected.body,/503/);
  assert.doesNotMatch(rejected.body,/PRIVATE_UPSTREAM_DETAIL|PROJECT_TOOL_OUTPUT|PROJECT_RESULT/);
  let state=await f.state();
  assert.equal(state.current.model,alternate);assert.equal(state.current.effort,'low');
  assert.equal(state.history.length,1);assert.equal(state.history[0].source,'automatic');
  assert.equal(state.history[0].status,'unverified');assert.equal(state.records[0].cooldownActive,true);
  assert.equal(state.failureCooldownSeconds,60);
  const firstHistory=state.history,probes=f.events.length;
  assert.ok(probes>=1 && probes<=3);assert.ok(f.events.every(x=>x==='probe'));
  assert.ok(f.probeModels.every(x=>x.model===alternate && x.effort==='low'));
  for(let i=0;i<6;i++) {
    const retry=await f.call(request);assert.equal(retry.status,409);
    assert.doesNotMatch(retry.body,/PROJECT_TOOL_OUTPUT|PROJECT_RESULT/);
  }
  assert.equal(f.events.length,probes);assert.deepEqual((await f.state()).history,firstHistory);
  await f.restart();assert.equal((await f.call(request)).status,409);
  assert.equal(f.events.length,probes);assert.deepEqual((await f.state()).history,firstHistory);

  f.probeFailure(null);
  f.guard.check({providerId:'provider',model:requested,effort:'high'});
  const deadline=Date.now()+5000;
  while(f.guard.snapshot().jobs.length && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  state=await f.state();assert.equal(state.jobs.length,0);
  assert.deepEqual(state.history.map(x=>[x.status,x.source]),[['passed','manual'],['unverified','automatic']]);
  assert.equal(state.current.model,alternate);assert.equal(state.current.effort,'low');
  assert.deepEqual(f.probeModels.slice(-3),Array.from({length:3},()=>({model:requested,effort:'high'})));
  assert.equal((await f.call()).status,200);assert.equal(f.events.length,probes+4);
});

test('upstream concurrency errors do not amplify automatic probes or history while cooling down',async t=>{
  const f=await fixture(t);f.configure({enabled:true,ttlSeconds:1800});
  f.probeFailure({status:429,body:{error:{code:'concurrency_queued',message:'All concurrency slots are busy'}}});
  assert.equal((await f.call()).status,409);
  const probes=f.events.length,history=(await f.state()).history;
  assert.equal(history.length,1);assert.match(history[0].reason,/429/);
  const retries=await Promise.all(Array.from({length:8},()=>f.call()));
  assert.ok(retries.every(r=>r.status===409));assert.equal(f.events.length,probes);
  assert.deepEqual((await f.state()).history,history);assert.ok(f.events.every(x=>x==='probe'));
});
