'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const http=require('node:http');
const {once}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {collectResponse}=require('./guard-transport.cjs');
const {createGuard}=require('./guard.cjs');
const {makeProxy}=require('./proxy.cjs');
const {parseNumbers}=require('./vendor/modeltrace/fingerprint-core.mjs');
const model='gpt-6-astra',other='gpt-5.4';
const numbers=Array.from({length:300},(_,i)=>i+1).join(',');
const message=text=>({type:'message',content:[{type:'output_text',text}]});
const ctx=()=>({key:'mock-route',providerId:'mock-provider',providerName:'Offline fixture',model,effort:'medium'});
const scoring=(score,expected)=>({used_outputs:3,diagnostics:[{accepted:true},{accepted:true},{accepted:true}],results:[{model:other,probability:score},{model,probability:expected}]});
function stream(events){
 const s=Readable.from(events.map(e=>Buffer.from('data: '+JSON.stringify(e)+'\n\n')));
 s.headers={'content-type':'text/event-stream'};return s;
}
function fixture(t,extra={}){
 const parent=fs.realpathSync(os.tmpdir()),runtime=fs.mkdtempSync(path.join(parent,'filter-v26-regression-'));
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(runtime)),parent);fs.rmSync(runtime,{recursive:true,force:true});});
 const guard=createGuard({runtime,probe:async()=>({model,text:numbers}),...extra});
 guard.configure('mock-provider',{enabled:true,ttlSeconds:600});return{guard,runtime};
}

test('completed output replaces whitespace or partial deltas and empty convenience fields',async()=>{
 for(const delta of ['',' \n','1,2','I will now answer'])for(const output_text of [undefined,'', ' \n']){
  const response={model,status:'completed',output:[message(numbers)],...(output_text!==undefined?{output_text}:{})};
  const result=await collectResponse(stream([{type:'response.output_text.delta',delta},{type:'response.completed',response}]),{expectedModel:model});
  assert.equal(result.text,numbers);assert.equal(parseNumbers(result.text).length,300);
 }
});

test('delta-only and JSON responses remain supported and complete text is not duplicated',async()=>{
 let result=await collectResponse(stream([{type:'response.output_text.delta',delta:numbers},{type:'response.completed',response:{model,status:'completed'}}]),{expectedModel:model});
 assert.equal(result.text,numbers);
 const response=Readable.from([Buffer.from(JSON.stringify({model,status:'completed',output_text:'',output:[message(numbers)]}))]);
 response.headers={'content-type':'application/json'};
 result=await collectResponse(response,{expectedModel:model});assert.equal(result.text,numbers);
 result=await collectResponse(stream([{type:'response.output_text.delta',delta:numbers},{type:'response.completed',response:{model,status:'completed',output:[message(numbers)]}}]),{expectedModel:model});
 assert.equal(parseNumbers(result.text).length,300);
});

test('final prose is not replaced with more favorable earlier numeric deltas; reasoning is not scored',async()=>{
 const result=await collectResponse(stream([{type:'response.output_text.delta',delta:numbers},
  {type:'response.completed',response:{model,status:'completed',output:[message('Unable to provide an answer.')]}}]),{expectedModel:model});
 assert.equal(parseNumbers(result.text).length,0);
 const reasoning=await collectResponse(stream([{type:'response.reasoning_text.delta',delta:numbers},
  {type:'response.completed',response:{model,status:'completed',output:[{type:'reasoning',summary:[{type:'summary_text',text:numbers}]}]}}]),{expectedModel:model});
 assert.equal(parseNumbers(reasoning.text).length,0);
});

test('having final-looking numbers never bypasses missing completion or a model mismatch',async()=>{
 await assert.rejects(collectResponse(stream([{type:'response.output_text.delta',delta:numbers}]),{expectedModel:model}),{code:'guard_unverified'});
 await assert.rejects(collectResponse(stream([{type:'response.completed',response:{model:other,status:'completed',output:[message(numbers)]}}]),{expectedModel:model}),{code:'guard_blocked'});
});

test('empty and prose-only samples fail closed, do not retry, and record only safe diagnostics',async t=>{
 for(const text of [' \n','UPSTREAM_PRIVATE_CONTENT']){
  let calls=0;const f=fixture(t,{probe:async()=>{calls++;return{model,text};}});
  await assert.rejects(f.guard.ensure(ctx()),error=>{
   assert.match(error.message,/检测不通过/);assert.match(error.message,text.trim()?/正文不含可识别/:/未提取到非空正文/);
   return error.code==='guard_unverified';
  });
  assert.equal(calls,1);const state=f.guard.snapshot();
  assert.equal(state.records[0].cacheValid,false);assert.equal(state.history.length,1);assert.equal(state.history[0].status,'unverified');
  assert.doesNotMatch(fs.readFileSync(path.join(f.runtime,'model-guard.json'),'utf8'),/UPSTREAM_PRIVATE_CONTENT/);
  await assert.rejects(f.guard.ensure(ctx()),{code:'guard_unverified'});assert.equal(calls,1);
 }
});

test('same replacement candidate below confirmation threshold remains failed and is explained accurately',async t=>{
 let rounds=0;const f=fixture(t,{analyze:()=>++rounds===1?scoring(.968,.000023):scoring(.458,.1047)});
 await assert.rejects(f.guard.ensure(ctx()),error=>{
  assert.match(error.message,/复核仍最接近 gpt-5.4/);assert.match(error.message,/0.458/);assert.match(error.message,/检测不通过/);
  assert.doesNotMatch(error.message,/没有达成一致/);return error.code==='guard_unverified';
 });
 assert.equal(rounds,2);assert.equal(f.guard.snapshot().records[0].cacheValid,false);assert.equal(f.guard.snapshot().history.length,1);
});

test('a zero-number preflight prevents any project request from reaching the upstream',async t=>{
 let projectCalls=0;const f=fixture(t,{probe:async()=>({model,text:''})});
 const upstream=http.createServer((_q,r)=>{projectCalls++;r.end('PROJECT_PAYLOAD');});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const proxy=makeProxy({getUpstream:()=>`http://127.0.0.1:${upstream.address().port}`,guard:{shouldInspect:()=>true,
  prepare:async()=>{await f.guard.ensure(ctx());return ctx();},assertCurrent:()=>{},watch:()=>()=>{},budget:{bytes:0,limit:64*1024*1024}}});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 t.after(async()=>{for(const server of [proxy,upstream]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
 const response=await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,stream:true,input:'PROJECT'})});
 assert.equal(response.status,409);const body=await response.text();assert.match(body,/检测不通过/);assert.doesNotMatch(body,/PROJECT_PAYLOAD/);assert.equal(projectCalls,0);
});
