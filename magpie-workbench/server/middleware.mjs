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
function schemaMap(value){return !!value&&typeof value==='object'&&!Array.isArray(value)}
function hasRootUnion(schema){return Object.hasOwn(schema,'anyOf')||Object.hasOwn(schema,'oneOf')||Object.hasOwn(schema,'allOf')}
function resolveSchemaRef(root,branch){
 if(!schemaMap(branch)||typeof branch.$ref!=='string')return branch;
 for(const section of ['$defs','definitions']){
  const prefix='#/'+section+'/';
  if(!branch.$ref.startsWith(prefix))continue;
  const found=root?.[section]?.[branch.$ref.slice(prefix.length)];
  return schemaMap(found)?found:null;
 }
 return null;
}
function appendDistinct(values,value){
 const key=JSON.stringify(value);
 if(!values.some(existing=>JSON.stringify(existing)===key))values.push(value);
}
// A union branch is skipped only when it provably cannot describe an object.
function excludesObject(branch){
 if(branch===false)return true;
 if(!schemaMap(branch)||!Object.hasOwn(branch,'type'))return false;
 const types=Array.isArray(branch.type)?branch.type:[branch.type];
 return !types.includes('object');
}
// DeepSeek's strict Chat tool validator requires an object at the schema root.
// Codex's automation_update is a union at the root; fold it the same way
// Magpie's native Grok/Anthropic compatibility path does.
// The fold only relaxes: dropping an allOf member removes a conjunct, and the
// root keeps just the fields every object branch requires. A branch whose $ref
// cannot be resolved, or whose shape is unknown, therefore requires nothing.
function objectRootIn(root,schema,depth){
 if(!schemaMap(schema))return false;
 if(schema.type==='object'&&!hasRootUnion(schema))return false;
 const props=schemaMap(schema.properties)?{...schema.properties}:{};
 const required=Array.isArray(schema.required)?[...schema.required]:[];
 if(Array.isArray(schema.allOf)){
  for(const raw of schema.allOf){
   const branch=resolveSchemaRef(root,raw);
   if(!schemaMap(branch))continue;
   if(schemaMap(branch.properties)){
    for(const key of Object.keys(branch.properties)){
     if(!Object.hasOwn(props,key))props[key]=branch.properties[key];
    }
   }
   if(Array.isArray(branch.required))required.push(...branch.required);
  }
 }
 delete schema.allOf;
 const branches=[];
 let unknownBranch=false;
 for(const key of ['anyOf','oneOf']){
  if(!Array.isArray(schema[key]))continue;
  for(const raw of schema[key]){
   let branch=resolveSchemaRef(root,raw);
   if(excludesObject(branch))continue;
   if(!schemaMap(branch)){unknownBranch=true;continue}
   if(hasRootUnion(branch)&&depth<8){
    branch=JSON.parse(JSON.stringify(branch));
    objectRootIn(root,branch,depth+1);
   }
   if(excludesObject(branch))continue;
   if(branch.type!=='object'&&!Object.hasOwn(branch,'properties')){unknownBranch=true;continue}
   branches.push(branch);
  }
  delete schema[key];
 }
 const from=new Map();
 let common=null;
 for(const branch of branches){
  if(schemaMap(branch.properties)){
   for(const [key,value] of Object.entries(branch.properties)){
    if(Object.hasOwn(props,key))continue;
    if(!from.has(key))from.set(key,[]);
    appendDistinct(from.get(key),value);
   }
  }
  const branchRequired=Array.isArray(branch.required)?branch.required:[];
  common=common===null?[...branchRequired]:common.filter(name=>branchRequired.includes(name));
 }
 if(unknownBranch)common=[];
 for(const [key,variants] of from){
  props[key]=variants.length===1?variants[0]:{anyOf:variants};
 }
 const merged=[];
 for(const name of [...required,...(common||[])]){
  if(!merged.some(existing=>JSON.stringify(existing)===JSON.stringify(name)))merged.push(name);
 }
 schema.type='object';
 schema.properties=props;
 if(merged.length)schema.required=merged;
 else delete schema.required;
 return true;
}
export function onProvider(body,ctx){
 const provider=ctx?.provider;
 if(!body||typeof provider?.id!=='string')return;
 const model=(typeof provider.model==='string'?provider.model:body.model)||'';
 if(!/^deepseek(?:[-/]|$)/i.test(model))return;
 const aliases=ctx?.options?.aliases||{};
 const rules=ctx?.options?.providers||{};
 const id=Object.prototype.hasOwnProperty.call(aliases,provider.id)?aliases[provider.id]:provider.id;
 const rule=rules['magpie:'+id];
 // DeepSeek protocol compatibility is opt-in per provider; no ID is special.
 if(rule?.deepSeekObjectRoot!==true)return;
 let changed=false;
 const compatibility=[];
 collectCompatibility(body.tools,compatibility);
 // Resumed and Lite Codex sessions also load tools from these protocol items.
 // Magpie lifts them after this hook, so repairing only body.tools misses them.
 if(Array.isArray(body.input)){
  for(const item of body.input){
   if(item?.type==='tool_search_output'||item?.type==='additional_tools'){
    collectCompatibility(item.tools,compatibility);
   }
  }
 }
 for(const schema of compatibility){
  if(objectRootIn(schema,schema,0))changed=true;
 }
 return changed?body:undefined;
}
function collectCompatibility(tools,found){
 if(!Array.isArray(tools))return;
 for(const tool of tools){
  if(!schemaMap(tool))continue;
  const target=schemaMap(tool.function)?tool.function:tool;
  const name=target.name||tool.name;
  if(typeof name==='string'&&/automation_update$/i.test(name)){
   for(const key of ['parameters','input_schema','inputSchema']){
    if(schemaMap(target[key]))found.push(target[key]);
   }
  }
  collectCompatibility(tool.tools,found);
 }
}
`;
}
