'use strict';

// Explicit diagnostic only: isolated rules/runtime, read-only CCS database,
// 3-6 fingerprint probes and one harmless text response; no tools/project input.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {once}=require('node:events');
const {createGuardService}=require('./guard-service.cjs');
const {makeProxy}=require('./proxy.cjs');

async function main() {
  if (!process.argv.includes('--allow-paid-probe')) throw new Error('This diagnostic sends paid upstream requests. Re-run with --allow-paid-probe only when intended.');
  const service=JSON.parse(fs.readFileSync(path.join(__dirname,'.runtime','service.json'),'utf8'));
  const base=service.filterOrigin+'/__codex_filter__';
  const health=await(await fetch(base+'/health')).json();
  const liveState=await(await fetch(base+'/api/state',{headers:{'x-filter-token':service.token}})).json();
  const before=JSON.stringify(liveState.guard.providers);
  const current=liveState.guard.current;
  if(!current.available)throw new Error('Current provider route unavailable.');
  const auth=JSON.parse(fs.readFileSync(path.join(path.dirname(service.configPath),'auth.json'),'utf8'));
  if(typeof auth.OPENAI_API_KEY!=='string')throw new Error('Local proxy authentication unavailable.');
  const root=fs.realpathSync(os.tmpdir());
  const runtime=fs.mkdtempSync(path.join(root,'codex-live-guard-check-'));
  const started=Date.now();let server;
  try {
    const guard=createGuardService({runtime,databasePath:health.routingOptions.databasePath,
      configPath:service.configPath,getUpstream:()=>health.upstream});
    guard.configure(current.providerId,{enabled:true,ttlSeconds:600});
    server=makeProxy({getUpstream:()=>health.upstream,guard});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/responses',{
      method:'POST',signal:AbortSignal.timeout(210000),headers:{'content-type':'application/json',authorization:'Bearer '+auth.OPENAI_API_KEY,originator:'codex_cli_rs'},
      body:JSON.stringify({model:current.model,reasoning:{effort:current.effort},store:false,stream:true,
        include:['reasoning.encrypted_content'],instructions:'Reply with exactly GUARD_OK. Do not use any tools.',
        input:[{role:'user',content:[{type:'input_text',text:'Reply with exactly GUARD_OK.'}]}]})});
    const body=await response.text();
    const snapshot=guard.snapshot();
    const after=await(await fetch(base+'/api/state',{headers:{'x-filter-token':service.token}})).json();
    const result={timestamp:new Date().toISOString(),filterVersion:health.filterVersion,isolated:true,
      providerId:current.providerId,model:current.model,effort:current.effort,status:response.status,
      verifiedCompletion:body.includes('response.completed')&&body.includes('GUARD_OK')&&!body.includes('event: error'),
      elapsedMs:Date.now()-started,records:snapshot.records,
      productionGuardSettingsUnchanged:before===JSON.stringify(after.guard.providers),
      receivedHeartbeat:body.includes(': model guard is verifying')};
    // Never save raw upstream output, reasoning, auth, or probe samples.
    fs.writeFileSync(path.join(__dirname,'.runtime','guard-live-protected-verification.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
    if(!result.verifiedCompletion||!result.productionGuardSettingsUnchanged)process.exitCode=1;
  } finally {
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    const resolved=fs.realpathSync(runtime);
    if(path.dirname(resolved)!==root||!path.basename(resolved).startsWith('codex-live-guard-check-'))throw new Error('Invalid scratch cleanup path.');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
