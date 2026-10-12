'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createGuardService,readRoute,topString} = require('./guard-service.cjs');
const {createManagement} = require('./management.cjs');

function fixture(t,extra = {}) {
  const root = fs.realpathSync(process.env.PI_SCRATCH_DIR);
  const runtime = fs.mkdtempSync(path.join(root,'guard-service-'));
  const databasePath = path.join(runtime,'mock.db'), configPath = path.join(runtime,'config.toml');
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE providers(id TEXT,name TEXT,app_type TEXT,is_current INTEGER,settings_config TEXT,sort_index INTEGER); CREATE TABLE proxy_config(app_type TEXT,auto_failover_enabled INTEGER);INSERT INTO proxy_config VALUES('codex',0)");
  const insert=(id,current)=>db.prepare('INSERT INTO providers VALUES(?,?,?,?,?,0)').run(id,id,'codex',current,JSON.stringify({auth:{OPENAI_API_KEY:'ROUTE_SECRET'},config:'model_provider="custom"\n[model_providers.custom]\nbase_url="https://'+id+'.example/v1"'}));
  insert('one',1);insert('two',0);
  fs.writeFileSync(configPath,'model="gpt-6-astra"\nmodel_reasoning_effort="high"\nmodel_provider="ccswitch"\n[model_providers.ccswitch]\nbase_url="http://127.0.0.1:18181/v1"\n');
  fs.writeFileSync(path.join(runtime,'auth.json'),JSON.stringify({OPENAI_API_KEY:'LOCAL_AUTH_SECRET'}));
  const guard=createGuardService({runtime,databasePath,configPath,getUpstream:()=> 'http://127.0.0.1:15721',...extra});
  const manager=createManagement({runtime,databasePath,guard});
  t.after(()=>{db.close();assert.equal(path.dirname(fs.realpathSync(runtime)),root);fs.rmSync(runtime,{recursive:true,force:true});});
  return {runtime,databasePath,configPath,db,guard,manager};
}
const input={model:'gpt-6-astra',reasoning:{effort:'high'}};
const transport={upstream:'http://127.0.0.1:15721',path:'/v1/responses',headers:{authorization:'Bearer REQUEST_SECRET'}};
const values=Array.from({length:300},(_,i)=>(i%355)+1).join(',');

test('strict route fingerprints change with credentials and reject failover/unknown routing',t=>{
  const f=fixture(t), first=readRoute(f.databasePath,transport.upstream);
  assert.equal(first.available,true);assert.equal(first.providerId,'one');
  f.db.exec("UPDATE providers SET settings_config=replace(settings_config,'ROUTE_SECRET','NEW_SECRET') WHERE id='one'");
  assert.notEqual(readRoute(f.databasePath,transport.upstream).digest,first.digest);
  f.db.exec('UPDATE proxy_config SET auto_failover_enabled=1');assert.equal(readRoute(f.databasePath,transport.upstream).available,false);
  f.db.exec('DELETE FROM providers');assert.equal(readRoute(f.databasePath,transport.upstream).available,false);
});
test('disabled suppliers remain passthrough while enabled unsupported model blocks',async t=>{
  const f=fixture(t,{probe:async()=>{throw new Error('unexpected probe');}});
  assert.equal(f.guard.shouldInspect(),false);
  f.guard.configure('one',{enabled:true,ttlSeconds:600});assert.equal(f.guard.shouldInspect(),true);
  await assert.rejects(f.guard.prepare({...input,model:'unlisted-model'},transport),{code:'guard_unsupported'});
  f.db.exec("UPDATE providers SET is_current=(id='two')");assert.equal(f.guard.shouldInspect(),false);
  f.db.exec('UPDATE proxy_config SET auto_failover_enabled=1');assert.equal(f.guard.shouldInspect(),true);
  await assert.rejects(f.guard.prepare(input,transport),{code:'guard_unverified'});
});
test('manual check can probe while disabled and never discloses credentials in state or files',async t=>{
  let calls=0;
  const f=fixture(t,{probe:async({context})=>{calls++;assert.equal(context.transport.headers.authorization,'Bearer LOCAL_AUTH_SECRET');return {model:context.model,text:values};}});
  f.manager.handle('POST','/guard/check',{providerId:'one'});
  for(let i=0;i<100&&f.guard.snapshot().jobs.length;i++) await new Promise(r=>setTimeout(r,10));
  assert.ok([3,6].includes(calls));assert.equal(f.guard.snapshot().jobs.length,0);
  assert.equal(f.guard.snapshot().providers.one?.enabled || false,false);
  const saved=fs.readFileSync(path.join(f.runtime,'model-guard.json'),'utf8');
  assert.doesNotMatch(saved,/ROUTE_SECRET|LOCAL_AUTH_SECRET|REQUEST_SECRET/);
  assert.doesNotMatch(JSON.stringify(f.manager.state()),/ROUTE_SECRET|LOCAL_AUTH_SECRET|REQUEST_SECRET/);
  assert.throws(()=>f.manager.handle('POST','/guard/check',{providerId:'two'}),{code:'guard_unverified'});
});
test('guard management validates provider and settings independently from history',t=>{
  const f=fixture(t), before=f.manager.policy();
  f.manager.handle('PUT','/guard/providers/one',{enabled:true,ttlSeconds:60,revision:f.manager.state().guard.settingsRevision});
  assert.deepEqual(f.guard.snapshot().providers.one,{enabled:true,ttlSeconds:60});assert.deepEqual(f.manager.policy(),before);
  assert.throws(()=>f.manager.handle('PUT','/guard/providers/missing',{enabled:true,ttlSeconds:600}),{code:'unknown_provider'});
  assert.throws(()=>f.manager.handle('PUT','/guard/providers/one',{enabled:true,ttlSeconds:-5,revision:f.manager.state().guard.settingsRevision}),{code:'guard_invalid_setting'});
});
test('corrupt guard settings fail closed even if enabled providers cannot be read',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.runtime,'model-guard.json'),'INVALID');
  const broken=createGuardService({runtime:f.runtime,databasePath:f.databasePath,configPath:f.configPath,getUpstream:()=>transport.upstream});
  assert.throws(()=>broken.shouldInspect(),{code:'guard_unverified'});
  assert.match(broken.snapshot().error,/损坏/);
});
test('top-level model reader ignores section model and secrets',()=>{
  assert.equal(topString('model="first" # comment\n[x]\nmodel="second"','model'),'first');
  assert.equal(topString('[x]\nmodel="second"','model'),undefined);
});
test('switching away and back invalidates cached trust but keeps the stable latch key',async t=>{
  const invalidated=[];
  const f=fixture(t,{engineFactory:()=>({snapshot:()=>({providers:{one:{enabled:true}},records:[],models:['gpt-6-astra']}),
    policy:id=>({enabled:id==='one',ttlSeconds:600}),invalidate:id=>invalidated.push(id),ensure:async()=>{},assertAllowed:()=>{}})});
  const first=await f.guard.prepare(input,transport);
  f.db.exec("UPDATE providers SET is_current=(id='two')");f.guard.snapshot();
  f.db.exec("UPDATE providers SET is_current=(id='one')");
  const second=await f.guard.prepare(input,transport);
  assert.equal(first.key,second.key);assert.ok(invalidated.filter(id=>id==='one').length>=2);
});
test('stale or missing settings revisions cannot disable protection from another page',t=>{
  const f=fixture(t), stale=f.manager.state().guard.settingsRevision;
  const enabled=f.manager.handle('PUT','/guard/providers/one',{enabled:true,ttlSeconds:600,revision:stale});
  assert.notEqual(enabled.guard.settingsRevision,stale);
  assert.throws(()=>f.manager.handle('PUT','/guard/providers/one',{enabled:false,ttlSeconds:60,revision:stale}),{code:'guard_settings_changed',status:409});
  assert.throws(()=>f.manager.handle('PUT','/guard/providers/one',{enabled:false,ttlSeconds:60}),{code:'guard_settings_changed',status:409});
  assert.deepEqual(f.guard.snapshot().providers.one,{enabled:true,ttlSeconds:600});
  const updated=f.manager.handle('PUT','/guard/providers/one',{enabled:true,ttlSeconds:60,revision:enabled.guard.settingsRevision});
  assert.deepEqual(updated.guard.providers.one,{enabled:true,ttlSeconds:60});
  const restarted=createGuardService({runtime:f.runtime,databasePath:f.databasePath,configPath:f.configPath,getUpstream:()=>transport.upstream});
  assert.notEqual(restarted.snapshot().settingsRevision,updated.guard.settingsRevision);
  assert.throws(()=>restarted.configure('one',{enabled:false,ttlSeconds:600},updated.guard.settingsRevision),{code:'guard_settings_changed'});
  assert.equal(restarted.snapshot().providers.one.enabled,true);
});
test('probe results, cache reads and no-op settings saves keep the settings revision stable',async t=>{
  const {createGuard}=require('./guard.cjs');
  const f=fixture(t,{probe:async()=>({model:input.model,text:values}),engineFactory:opts=>createGuard({...opts,analyze:()=>({used_outputs:3,
    diagnostics:Array.from({length:3},()=>({accepted:true})),results:[{model:input.model,probability:.98},{model:'gpt-6-luna',probability:.02}]})})});
  f.guard.configure('one',{enabled:true,ttlSeconds:600});
  const revision=f.manager.state().guard.settingsRevision;
  const context=await f.guard.prepare(input,transport);
  f.guard.assertCurrent(context);
  assert.equal(f.manager.state().guard.settingsRevision,revision);
  f.manager.handle('PUT','/guard/providers/one',{enabled:true,ttlSeconds:600,revision});
  assert.equal(f.manager.state().guard.settingsRevision,revision);
  f.manager.handle('PUT','/guard/providers/two',{enabled:true,ttlSeconds:60,revision});
  assert.notEqual(f.manager.state().guard.settingsRevision,revision);
});

test('manual model selection does not replace the latest observed request or its source',async t=>{
  const checks=[];
  const f=fixture(t,{engineFactory:()=>({snapshot:()=>({providers:{},records:[],models:['gpt-6-astra','gpt-6-luna']}),
    policy:()=>({enabled:false,ttlSeconds:600}),ensure:async context=>{checks.push(context);}})});
  let state=f.guard.snapshot();
  assert.equal(state.current.modelSource,'config');assert.equal(state.current.model,'gpt-6-astra');
  assert.equal(state.current.modelObservedAt,undefined);assert.deepEqual(state.configured,{model:'gpt-6-astra',effort:'high'});
  f.guard.observe({model:'gpt-6-luna',reasoning:{effort:'low'}},transport);
  const observed=f.guard.snapshot().current;
  assert.equal(observed.modelSource,'request');assert.equal(observed.model,'gpt-6-luna');
  assert.ok(Number.isFinite(Date.parse(observed.modelObservedAt)));
  f.guard.check({providerId:'one',model:'gpt-6-astra',effort:'max'});
  assert.equal(f.guard.snapshot().manualJobs[0].model,'gpt-6-astra');
  for(let i=0;i<20&&f.guard.snapshot().jobs.length;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(checks.length,1);assert.equal(checks[0].model,'gpt-6-astra');assert.equal(checks[0].effort,'max');
  state=f.guard.snapshot();assert.deepEqual(state.current,observed);
  assert.deepEqual(state.recentModels.map(c=>[c.model,c.effort]),[['gpt-6-luna','low']]);
  assert.doesNotMatch(JSON.stringify(state),/REQUEST_SECRET|LOCAL_AUTH_SECRET|ROUTE_SECRET|authorization/);
});

test('automatic requests keep their actual model and matching request credentials are used for manual probes',async t=>{
  const checks=[];
  const f=fixture(t,{engineFactory:()=>({snapshot:()=>({providers:{one:{enabled:true}},records:[],models:['gpt-6-astra','gpt-6-luna']}),
    policy:()=>({enabled:true,ttlSeconds:600}),ensure:async context=>{checks.push(context);},assertAllowed:()=>{}})});
  const astra=await f.guard.prepare(input,{...transport,headers:{authorization:'Bearer ASTRA_REQUEST_SECRET'}});
  const luna=await f.guard.prepare({model:'gpt-6-luna',reasoning:{effort:'low'}},{...transport,headers:{authorization:'Bearer LUNA_REQUEST_SECRET'}});
  assert.equal(astra.model,'gpt-6-astra');assert.equal(luna.model,'gpt-6-luna');
  f.guard.check({providerId:'one',model:input.model,effort:'high'});
  for(let i=0;i<20&&f.guard.snapshot().jobs.length;i++)await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(checks.map(c=>c.model),['gpt-6-astra','gpt-6-luna','gpt-6-astra']);
  assert.equal(checks[2].transport.headers.authorization,'Bearer ASTRA_REQUEST_SECRET');
  assert.equal(f.guard.snapshot().current.model,'gpt-6-luna');
  assert.doesNotMatch(JSON.stringify(f.guard.snapshot()),/ASTRA_REQUEST_SECRET|LUNA_REQUEST_SECRET/);
});

test('manual model without effort does not inherit another model effort; route changes hide stale observations and results',async t=>{
  const checks=[],records=[];
  const f=fixture(t,{engineFactory:()=>({snapshot:()=>({providers:{},records,models:['gpt-6-astra','gpt-6-luna']}),
    policy:()=>({enabled:false,ttlSeconds:600}),ensure:async context=>{checks.push(context);}})});
  f.guard.observe({model:'gpt-6-luna',reasoning:{effort:'low'}},transport);
  const observed=f.guard.snapshot().current;
  records.push({key:observed.key,providerId:'one',model:'gpt-6-luna',effort:'low',status:'passed'});
  assert.equal(f.guard.snapshot().currentRecords.length,1);
  f.guard.check({providerId:'one',model:'gpt-6-astra'});
  for(let i=0;i<20&&f.guard.snapshot().jobs.length;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(checks[0].effort,'high');
  f.db.exec("UPDATE providers SET settings_config=replace(settings_config,'ROUTE_SECRET','NEW_SECRET') WHERE id='one'");
  const state=f.guard.snapshot();assert.equal(state.current.modelSource,'config');
  assert.deepEqual(state.recentModels,[]);assert.deepEqual(state.currentRecords,[]);
});

test('manual selection rejects stale route revisions and clears prior route credentials',async t=>{
  const checks=[];
  const f=fixture(t,{engineFactory:()=>({snapshot:()=>({providers:{},records:[],models:['gpt-6-astra','gpt-6-luna']}),
    policy:()=>({enabled:false,ttlSeconds:600}),ensure:async context=>{checks.push(context);}})});
  f.guard.observe(input,transport);
  const first=f.guard.snapshot().current;
  f.guard.observe({model:'gpt-6-luna',reasoning:{effort:'low'}},transport);
  assert.equal(f.guard.snapshot().current.routeRevision,first.routeRevision);
  f.db.exec("UPDATE providers SET is_current=(id='two')");f.guard.snapshot();
  f.db.exec("UPDATE providers SET is_current=(id='one')");
  const next=f.guard.snapshot();
  assert.notEqual(next.current.routeRevision,first.routeRevision);
  assert.equal(next.current.modelSource,'config');assert.deepEqual(next.recentModels,[]);
  assert.throws(()=>f.guard.check({providerId:'one',model:input.model,routeRevision:first.routeRevision}),/路由已改变/);
  f.guard.check({providerId:'one',model:'unlisted-model',routeRevision:next.current.routeRevision});
  for(let i=0;i<20&&f.guard.snapshot().jobs.length;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(checks.length,1);assert.equal(checks[0].effort,'default');
  assert.equal(checks[0].transport.headers.authorization,'Bearer LOCAL_AUTH_SECRET');
  for(const payload of [null,[],{model:'\n'}, {model:input.model,effort:''},{model:input.model,effort:42}]) {
    assert.throws(()=>f.guard.check(payload),{code:'guard_unverified'});
  }
});
