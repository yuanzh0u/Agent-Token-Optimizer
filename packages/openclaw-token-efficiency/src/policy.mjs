import { evaluateCapability } from './capabilities.mjs';
const FEATURES=['loopGuard','outputCompression','historyCompaction','pruning','requestGate'];
const LIMITS=['windowTokens','outputReserveTokens','safetyMarginTokens','softContextTokens'];
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&[Object.prototype,null].includes(Object.getPrototypeOf(o));
function shape(o,keys,label) { if(!plain(o)||Object.keys(o).some(k=>!keys.includes(k))) throw new TypeError(`invalid ${label} shape/unknown controls`); }
function text(x,label) {if(typeof x!=='string'||!x.length) throw new TypeError(`invalid ${label}`);}
function control(p) {
 shape(p,['mode','features','limits','permissions'],'policy');
 if(p.mode!==undefined&&!['observe','enforce'].includes(p.mode)) throw new TypeError('invalid policy mode');
 if(p.features!==undefined) {shape(p.features,FEATURES,'features'); for(const v of Object.values(p.features)) if(typeof v!=='boolean') throw new TypeError('feature must be boolean');}
 if(p.limits!==undefined) {shape(p.limits,LIMITS,'limits'); for(const v of Object.values(p.limits)) if(!Number.isSafeInteger(v)||v<0) throw new TypeError('invalid policy limit');}
 if(p.permissions!==undefined&&(!Array.isArray(p.permissions)||p.permissions.some(v=>typeof v!=='string'||!v.length))) throw new TypeError('invalid permissions');
}
/** Validate the strict v1 policy shape; unknown controls and host-setting overrides reject. */
export function validatePolicy(config) {
 shape(config,['version','defaults','profiles','bindings'],'config');
 if(config.version!==1) throw new TypeError('unsupported policy version');
 control(Object.hasOwn(config,'defaults')?config.defaults:{});
 if(!plain(config.profiles)||!Array.isArray(config.bindings)) throw new TypeError('profiles and bindings required');
 for(const [name,p] of Object.entries(config.profiles)) {text(name,'profile name'); if(['__proto__','constructor','prototype'].includes(name)) throw new TypeError('unsafe profile'); control(p);}
 const ids=new Set();
 for(const b of config.bindings) {
  shape(b,['id','agentId','runId','profile','overrides'],'binding');
  text(b.id,'binding id'); text(b.agentId,'agentId'); text(b.profile,'profile');
  if(ids.has(b.id)) throw new TypeError('duplicate binding id'); ids.add(b.id);
  if(b.runId!==undefined) text(b.runId,'runId');
  if(!Object.hasOwn(config.profiles,b.profile)) throw new TypeError('unknown profile');
  if(b.overrides!==undefined) control(b.overrides);
 }
 return true;
}
/**
 * Resolve a fresh policy scoped to the exact opaque agent/session/run identity.
 * Merge defaults -> one binding profile -> overrides. Multiple matches or missing
 * identities prohibit intervention; evidence never expands host permissions.
 * @returns {{policy:object,provenance:object,scope:object,bindingId:string|null,effectiveMode:string,unsupportedReasons:string[],softContextLimit:number|null}}
 */
export function resolvePolicy(config,identity={},capabilities={},host={}) {
 validatePolicy(config);
 const scope=Object.fromEntries(['agentId','sessionId','runId'].map(k=>[k,typeof identity?.[k]==='string'&&identity[k].length?identity[k]:null]));
 const matches=config.bindings.filter(b=>scope.agentId!==null&&b.agentId===scope.agentId&&(b.runId===undefined||b.runId===scope.runId));
 const policy={mode:'observe'}, provenance={mode:'default'},unsupportedReasons=[];
 const apply=(p,origin)=>{for(const [k,v] of Object.entries(p)){ if(k==='features'||k==='limits') {policy[k]={...policy[k],...v}; for(const n of Object.keys(v))provenance[`${k}.${n}`]=origin;} else policy[k]=structuredClone(v); provenance[k]=origin;}};
 apply(config.defaults??{},'defaults');
 let bindingId=null;
 if(matches.length===1) { const b=matches[0];bindingId=b.id;apply(config.profiles[b.profile],`profile:${b.profile}`);apply(b.overrides??{},`binding:${b.id}`); }
 else unsupportedReasons.push(matches.length>1?'multiple matching bindings; intervention rejected':'unbound identity');
 if(Object.values(scope).some(v=>v===null)) unsupportedReasons.push('missing agent/session/run scope');
 if(policy.permissions?.some(p=>!Array.isArray(host.permissions)||!host.permissions.includes(p))) throw new TypeError('policy cannot expand host permissions');
 if(policy.mode==='enforce') for(const [feature,enabled] of Object.entries(policy.features??{})) if(enabled) {
  const result=evaluateCapability(capabilities,feature,host);
  if(result.status!=='verified') unsupportedReasons.push(`${feature}: ${result.reasons.join('; ')}`);
 }
 const l=policy.limits??{};
 const complete=['windowTokens','outputReserveTokens','safetyMarginTokens'].every(k=>Object.hasOwn(l,k));
 const available=complete?Math.max(0,l.windowTokens-l.outputReserveTokens-l.safetyMarginTokens):null;
 const softContextLimit=available===null?null:Math.min(l.softContextTokens??available,available);
 return {policy,provenance,scope,bindingId,effectiveMode:unsupportedReasons.length?'observe':policy.mode,unsupportedReasons,softContextLimit};
}
