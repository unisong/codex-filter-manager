'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const {once} = require('node:events');
const {makeProxy} = require('./proxy.cjs');
const {guardFailure,createEventParser,probe} = require('./guard-transport.cjs');

const model = 'gpt-6-astra';
const event = data => 'data: '+JSON.stringify(data)+'\n\n';
const created = () => event({type:'response.created',response:{model,status:'in_progress'}});
const tool = () => event({type:'response.output_item.added',item:{type:'function_call',name:'exec',arguments:'DO_NOT_RELEASE'}});
const completed = (actual = model) => event({type:'response.completed',response:{model:actual,status:'completed',output:[{content:[{type:'output_text',text:'已验证'}]}]}});
const pause = ms => new Promise(r=>setTimeout(r,ms));
async function fixture(t,handler,guard,extra = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const origin = 'http://127.0.0.1:'+upstream.address().port;
  const proxy = makeProxy({getUpstream:()=>origin,guard,...extra});
  proxy.listen(0,'127.0.0.1'); await once(proxy,'listening');
  t.after(async()=>{
    for(const s of [proxy,upstream]) { s.closeAllConnections(); await new Promise(r=>s.close(r)); }
  });
  return {origin,url:'http://127.0.0.1:'+proxy.address().port+'/v1/responses'};
}
function fakeGuard(extra = {}) {
  return {shouldInspect:()=>true,prepare:async()=>({key:'k',model}),assertCurrent:()=>{},
    watch:()=>()=>{},block:()=>{},budget:{bytes:0,limit:64*1024*1024},...extra};
}
const request = url => fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,stream:true,input:'PROJECT_SECRET'})});

test('failed preflight sends zero project requests and exposes a guard error',async t=>{
  let calls = 0;
  const f = await fixture(t,(_q,r)=>{calls++;r.end('unsafe');},fakeGuard({prepare:async()=>{throw guardFailure('未能验证');}}));
  const response=await request(f.url);
  assert.equal(response.status,409); assert.match(await response.text(),/guard_unverified/); assert.equal(calls,0);
});
test('model mismatch with prior tool delta releases no tool output and latches route',async t=>{
  let blocked;
  const f = await fixture(t,(_q,r)=>{r.writeHead(200,{'content-type':'text/event-stream'});r.end(created()+tool()+completed('gpt-6-luna'));},
    fakeGuard({block:(_context,actual)=>{blocked=actual;}}));
  const response=await request(f.url), text=await response.text();
  assert.equal(response.status,409); assert.match(text,/guard_blocked/); assert.doesNotMatch(text,/DO_NOT_RELEASE/); assert.equal(blocked,'gpt-6-luna');
});
test('incomplete response discards tool deltas rather than delivering them',async t=>{
  const f=await fixture(t,(_q,r)=>{r.writeHead(200,{'content-type':'text/event-stream'});r.end(created()+tool());},fakeGuard());
  const response=await request(f.url),text=await response.text();
  assert.equal(response.status,409); assert.doesNotMatch(text,/DO_NOT_RELEASE/); assert.match(text,/guard_unverified/);
});
test('compressed complete response is verified then delivered with correct decoded headers',async t=>{
  const original=created()+completed();
  const zipped=zlib.gzipSync(Buffer.from(original));
  const f=await fixture(t,(_q,r)=>{r.writeHead(200,{'content-type':'text/event-stream','content-encoding':'gzip','content-length':String(zipped.length)});r.end(zipped);},fakeGuard());
  const response=await request(f.url);
  assert.equal(response.status,200); assert.equal(response.headers.get('content-encoding'),null); assert.equal(await response.text(),original);
});
test('protected output is held until completion, while guard off preserves streaming',async t=>{
  let finish;
  const ready=new Promise(r=>finish=r);
  const f=await fixture(t,async(_q,r)=>{
    r.writeHead(200,{'content-type':'text/event-stream'});r.write(created()+tool());
    await ready;r.end(completed());
  },fakeGuard());
  let headersReceived=false;
  const result=request(f.url).then(r=>{headersReceived=true;return r.text();});
  await pause(100);assert.equal(headersReceived,false);finish();assert.match(await result,/DO_NOT_RELEASE/);
});
test('latch from another request cancels buffered response without releasing tools',async t=>{
  const guard=fakeGuard({watch:(_context,controller)=>{const timer=setTimeout(()=>controller.abort(),60);return()=>clearTimeout(timer);}});
  const f=await fixture(t,(_q,r)=>{r.writeHead(200,{'content-type':'text/event-stream'});r.write(created()+tool());},guard);
  const response=await request(f.url),text=await response.text();
  assert.doesNotMatch(text,/DO_NOT_RELEASE/);assert.match(text,/guard_unverified/);
});
test('provider switch during 429 wait prevents a second business send',async t=>{
  let calls=0,checks=0;
  const f=await fixture(t,(_q,r)=>{calls++;r.writeHead(429);r.end('queue full');},
    fakeGuard({assertCurrent:()=>{if(++checks>=2) throw guardFailure('route changed');}}),
    {retry429:{maxAttempts:3,baseDelayMs:1,maxDelayMs:1,budgetMs:500}});
  const response=await request(f.url);assert.equal(response.status,409);await response.text();assert.equal(calls,1);
});
test('SSE parser preserves split UTF-8 and multiline data, rejects malformed JSON',()=>{
  const output=[];const parser=createEventParser(e=>output.push(e));
  const text=': comment\r\ndata: {"type":"test",\r\ndata: "text":"中文"}\r\n\r\n';
  for(const b of Buffer.from(text)) parser.push(Buffer.from([b]));
  parser.end();assert.deepEqual(output,[{type:'test',text:'中文'}]);
  assert.throws(()=>parser.push(Buffer.from('data: oops\n\n')),{code:'guard_unverified'});
});
test('synthetic probe carries no project messages or tool/session headers',async t=>{
  let input,headers;
  const f=await fixture(t,async(q,r)=>{
    headers=q.headers; const chunks=[];for await(const c of q) chunks.push(c);input=JSON.parse(Buffer.concat(chunks));
    r.writeHead(200,{'content-type':'text/event-stream'});r.end(created()+completed());
  },null);
  const result=await probe({context:{model,effort:'high',transport:{upstream:f.origin,path:'/v1/responses',headers:{authorization:'Bearer test-key','session_id':'PROJECT_SESSION','x-project-path':'SECRET_PATH'}}},prompt:'Return 300 integers.'});
  assert.equal(result.text,'已验证');assert.equal(input.tools,undefined);assert.equal(headers['x-project-path'],undefined);assert.notEqual(headers.session_id,'PROJECT_SESSION');
  assert.equal(input.input.length,1);assert.equal(input.reasoning.effort,'high');assert.doesNotMatch(JSON.stringify(input),/PROJECT_SECRET|SECRET_PATH/);
});
test('events after completion and oversized buffers are denied',async t=>{
  const f=await fixture(t,(_q,r)=>{r.writeHead(200,{'content-type':'text/event-stream'});r.end(completed()+tool());},fakeGuard());
  const response=await request(f.url);assert.equal(response.status,409);assert.doesNotMatch(await response.text(),/DO_NOT_RELEASE/);
  const tiny=fakeGuard({budget:{bytes:0,limit:10}});
  const f2=await fixture(t,(_q,r)=>{r.writeHead(200,{'content-type':'text/event-stream'});r.end(created()+completed());},tiny);
  assert.equal((await request(f2.url)).status,409);assert.equal(tiny.budget.bytes,0);
});
test('long preflight emits only heartbeat comments before explicit denial',async t=>{
  let calls=0;
  const f=await fixture(t,(_q,r)=>{calls++;r.end('unsafe');},fakeGuard({prepare:async()=>{await pause(5300);throw guardFailure('检测未通过');}}));
  const response=await request(f.url);
  assert.equal(response.headers.get('content-type'),'text/event-stream');
  const reader=response.body.getReader();
  const first=await reader.read();assert.match(Buffer.from(first.value).toString(),/^: model guard/);
  let text='';for(;;){const part=await reader.read();if(part.done)break;text+=Buffer.from(part.value).toString();}
  assert.match(text,/event: error/);assert.match(text,/guard_unverified/);assert.equal(calls,0);
});
test('protected redirects cannot send the project to an address outside the guard',async t=>{
  let escapedRequests=0;
  const target=http.createServer((_q,r)=>{escapedRequests++;r.end('UNVERIFIED_REDIRECT_OUTPUT');});
  target.listen(0,'127.0.0.1');await once(target,'listening');
  t.after(async()=>{target.closeAllConnections();await new Promise(r=>target.close(r));});
  const f=await fixture(t,(_q,r)=>{
    r.writeHead(307,{location:'http://127.0.0.1:'+target.address().port+'/outside-guard'});r.end();
  },fakeGuard());
  const response=await request(f.url),text=await response.text();
  assert.equal(response.status,409);assert.equal(response.redirected,false);
  assert.equal(response.headers.get('location'),null);assert.match(text,/guard_unverified/);
  assert.doesNotMatch(text,/UNVERIFIED_REDIRECT_OUTPUT/);assert.equal(escapedRequests,0);
});
