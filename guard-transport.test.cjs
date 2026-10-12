'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const {once} = require('node:events');
const {probe,PROBE_TIMEOUT_MS} = require('./guard-transport.cjs');

async function rejectedProbe(t, handler, extra = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  let error;
  try {
    await probe({context: {model: 'gpt-6-luna', effort: 'low', transport: {
      upstream: 'http://127.0.0.1:' + upstream.address().port,
      path: '/v1/responses', headers: {authorization: 'Bearer LOCAL_TEST_KEY'}
    }}, prompt: 'Return only numbers.', ...extra});
  } catch (caught) { error = caught; }
  assert.equal(error?.code, 'guard_unverified');
  assert.equal(error?.status, 409);
  return error;
}

test('probe explains model_not_found without persisting upstream prose or credentials', async t => {
  const error = await rejectedProbe(t, (_q, r) => {
    r.writeHead(503, {'content-type': 'application/json'});
    r.end(JSON.stringify({error: {code: 'model_not_found',
      message: 'No channel for model. Authorization: Bearer UPSTREAM_SECRET /private/path'}}));
  });
  assert.match(error.message, /HTTP 503.*模型不可用.*model_not_found/);
  assert.match(error.message, /不是降智结论/);
  assert.doesNotMatch(error.message, /UPSTREAM_SECRET|Authorization|private/);
});

test('compressed quota errors are distinguished from rate limiting', async t => {
  const error = await rejectedProbe(t, (_q, r) => {
    r.writeHead(429, {'content-type': 'application/json', 'content-encoding': 'gzip'});
    r.end(zlib.gzipSync(JSON.stringify({error: {type: 'insufficient_quota', message: 'PRIVATE_ACCOUNT'}})));
  });
  assert.match(error.message, /HTTP 429.*余额或配额不足.*insufficient_quota/);
  assert.doesNotMatch(error.message, /PRIVATE_ACCOUNT|并发超限/);
});

test('concurrency queues and authentication errors have fixed actionable explanations', async t => {
  for (const [status,body,expected] of [
    [429,{error:{code:'concurrency_queued',message:'All concurrency slots are busy. SECRET_QUEUE_DETAILS'}},/并发名额已满.*排队/],
    [401,{error:{message:'SECRET_AUTH_DETAILS'}},/认证失败/],
    [403,{error:{message:'SECRET_AUTH_DETAILS'}},/拒绝访问/]
  ]) {
    const error=await rejectedProbe(t,(_q,r)=>{r.writeHead(status);r.end(JSON.stringify(body));});
    assert.match(error.message,expected);assert.doesNotMatch(error.message,/SECRET/);
  }
});

test('known error messages classify unsupported models without echoing an arbitrary code', async t => {
  const error = await rejectedProbe(t, (_q, r) => {
    r.writeHead(503, {'content-type': 'application/json'});
    r.end(JSON.stringify({error: {code: 'SECRET_CUSTOM_CODE',
      message: '当前模型 gpt-6-luna 没有可用渠道，供应商密钥 SECRET_KEY'}}));
  });
  assert.match(error.message, /模型不可用或没有可用渠道/);
  assert.doesNotMatch(error.message, /SECRET_CUSTOM_CODE|SECRET_KEY/);
});

test('specific upstream reasons take precedence over a generic server_error wrapper', async t => {
  for (const detail of [{type: 'model_not_found'}, {message: '该模型没有可用渠道'}]) {
    const error = await rejectedProbe(t, (_q, r) => {
      r.writeHead(503, {'content-type': 'application/json'});
      r.end(JSON.stringify({error: {code: 'server_error', ...detail}}));
    });
    assert.match(error.message, /模型不可用或没有可用渠道/);
  }
});

test('unknown JSON, HTML, and malformed responses retain a useful safe status description', async t => {
  for (const body of [JSON.stringify({error: {code: 'SECRET_CUSTOM_CODE', message: 'PRIVATE_ACCOUNT'}}),
    '<html><body>PRIVATE_ACCOUNT<script>alert(1)</script></body></html>', '{"error":"PRIVATE_ACCOUNT"']) {
    const error = await rejectedProbe(t, (_q, r) => { r.writeHead(429); r.end(body); });
    assert.match(error.message, /HTTP 429.*请求受限/);
    assert.doesNotMatch(error.message, /PRIVATE_ACCOUNT|SECRET_CUSTOM_CODE|script/);
  }
});

test('oversized errors stop reading and cannot persist an unbounded payload', async t => {
  const error = await rejectedProbe(t, (_q, r) => {
    r.writeHead(503, {'content-type': 'application/json'});
    r.end(JSON.stringify({error: {code: 'model_not_found', message: 'PRIVATE'.repeat(10000)}}));
  });
  assert.match(error.message, /HTTP 503.*服务暂时不可用/);
  assert.doesNotMatch(error.message, /PRIVATE|model_not_found/);
});

test('error bodies without an end are bounded by a short read deadline', {timeout: 5000}, async t => {
  const started = Date.now();
  const error = await rejectedProbe(t, (_q, r) => {
    r.writeHead(503, {'content-type': 'application/json'});
    r.write('{"error":');
  });
  assert.match(error.message, /HTTP 503/);
  assert.ok(Date.now() - started < 4000);
});

test('probe cancellation also interrupts a stalled error body', {timeout: 2000}, async t => {
  const controller = new AbortController();
  const error = await rejectedProbe(t, (_q, r) => {
    r.writeHead(503, {'content-type': 'application/json'});
    r.write('{"error":');
    setTimeout(() => controller.abort(), 30);
  }, {signal: controller.signal});
  assert.match(error.message, /取消/);
});

test('probe preserves the local deadline reason after headers instead of reporting generic connection failure',async t=>{
  const error=await rejectedProbe(t,(_q,r)=>{
    r.writeHead(200,{'content-type':'text/event-stream'});
    r.write('data: '+JSON.stringify({type:'response.created',response:{model:'gpt-6-luna',status:'in_progress'}})+'\n\n');
  },{timeoutMs:100});
  assert.match(error.message,/单个检测样本等待超过.*已停止/);
  assert.doesNotMatch(error.message,/上游连接异常/);
});

test('probe deadline also bounds streams that send endless keepalive comments',async t=>{
  const error=await rejectedProbe(t,(_q,r)=>{
    r.writeHead(200,{'content-type':'text/event-stream'});
    const timer=setInterval(()=>r.write(': still working\n\n'),20);r.on('close',()=>clearInterval(timer));
  },{timeoutMs:150});
  assert.match(error.message,/单个检测样本等待超过/);
});

test('slow reasoning may be silent beyond sixty seconds and still return a fully verified sample', {timeout:80000},async t=>{
  assert.equal(PROBE_TIMEOUT_MS,180000);
  const upstream=http.createServer(async(q,r)=>{
    const chunks=[];for await(const chunk of q)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks));
    assert.equal(input.reasoning.effort,'high');
    r.writeHead(200,{'content-type':'text/event-stream'});
    r.write('data: '+JSON.stringify({type:'response.created',response:{model:input.model,status:'in_progress'}})+'\n\n');
    const timer=setTimeout(()=>r.end('data: '+JSON.stringify({type:'response.completed',response:{model:input.model,status:'completed',output:[{type:'message',content:[{type:'output_text',text:'1 2 3'}]}]}})+'\n\n'),65000);
    r.on('close',()=>clearTimeout(timer));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  t.after(async()=>{upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
  const result=await probe({context:{model:'gpt-6-astra',effort:'high',transport:{upstream:'http://127.0.0.1:'+upstream.address().port,path:'/v1/responses',headers:{}}},prompt:'fixture'});
  assert.equal(result.model,'gpt-6-astra');assert.equal(result.text,'1 2 3');
});
