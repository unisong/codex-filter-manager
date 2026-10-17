import fs from 'node:fs';
import {createHash} from 'node:crypto';

// Preserve the reviewed history baseline byte-for-byte. Bundle the search
// portability extension separately in Magpie's import-free request sandbox.
const source = fs.readFileSync(new URL('../history/codex-history.middleware.js', import.meta.url), 'utf8');
const search = fs.readFileSync(new URL('../history/portable-web-search.mjs', import.meta.url), 'utf8');
const provenance = JSON.parse(fs.readFileSync(new URL('../history/PROVENANCE.json', import.meta.url)));
if (createHash('sha256').update(source).digest('hex') !== provenance.sha256) throw Error('History hook checksum mismatch');
export function combineMiddleware(gate = 'export function onRequest() {}') {
  const rename = (code, name) => {
    if (code.split('export function onRequest(').length !== 2) throw Error('Unexpected middleware export');
    return code.replace('export function onRequest(', 'function ' + name + '(');
  };
  return '// Magpie Codex Workbench: history remains usable without the detector service.\n'
    + rename(source, 'historyRequest') + '\n' + search.replace('export function portableWebSearch(', 'function portableWebSearch(')
    + '\n' + rename(gate, 'protectionRequest') + `
export function onRequest(body,ctx){
 let rejected=false;
 const scoped={...ctx,reject:(...args)=>{rejected=true;ctx.reject(...args)}};
 let routed;
 try{routed=protectionRequest(body,scoped)}catch{}
 if(rejected)return;
 const filtered=historyRequest(routed||body,scoped);
 if(rejected)return;
 if(filtered&&Array.isArray(filtered.input)){
  try{return {...filtered,input:filtered.input.map(item=>item?.type==='web_search_call'?portableWebSearch(item):item)}}
  catch{scoped.reject(409,'Codex history filter: web search history could not be safely converted to text.');return}
 }
 return filtered||routed;
}
`;
}
