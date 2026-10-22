import { createHash } from 'node:crypto';
const unsafe=new Set(['__proto__','prototype','constructor']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
function canonical(v,seen=new Set()) {
 if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)) return JSON.stringify(v);
 if(typeof v!=='object'||seen.has(v)) throw new TypeError('config must be finite acyclic JSON');
 seen.add(v); let result;
 if(Array.isArray(v)) result=`[${v.map(x=>canonical(x,seen)).join(',')}]`;
 else {if(!plain(v)||Object.keys(v).some(k=>unsafe.has(k))) throw new TypeError('unsafe config object'); result=`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k],seen)}`).join(',')}}`;}
 seen.delete(v);return result;
}
/** Stable SHA-256 over the entire private JSON config, including secrets and key presence. */
export function fingerprint(config) { return createHash('sha256').update(canonical(config)).digest('hex'); }
const sensitiveKey=key=>/secret|password|passwd|token|apikey|accesskey|privatekey|credential|authorization|cookie/.test(key.toLowerCase().replace(/[^a-z0-9]/g,''));
function credentialUrl(value) {
 if(typeof value!=='string'||! /^[a-z][a-z0-9+.-]*:\/\//i.test(value))return false;
 try {
  const url=new URL(value);
  return !!(url.username||url.password)||[...url.searchParams.keys()].some(key=>sensitiveKey(key)||['key','auth','sig','signature'].includes(key.toLowerCase()));
 }catch{return /[@?#]/.test(value);}
}
/** Public snapshot: sensitive keys and credential-bearing URLs become one-way hashes. */
export function redactConfig(config) {
 fingerprint(config);
 const redact=v=>`[redacted:sha256:${fingerprint(v)}]`;
 const walk=v=>credentialUrl(v)?redact(v):Array.isArray(v)?v.map(walk):plain(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,sensitiveKey(k)?redact(x):walk(x)])):v;
 return walk(config);
}
function validPath(path) {if(!Array.isArray(path)||!path.length||path.some(k=>typeof k!=='string'||!k.length||unsafe.has(k))) throw new TypeError('unsafe patch path');}
function locate(config,path) {
 let o=config;
 for(const k of path.slice(0,-1)) { if(!plain(o)||!Object.hasOwn(o,k))return {exists:false};o=o[k]; }
 const k=path.at(-1);return plain(o)&&Object.hasOwn(o,k)?{exists:true,value:structuredClone(o[k])}:{exists:false};
}
function put(config,path,state) {
 let o=config;
 for(const k of path.slice(0,-1)) {if(!Object.hasOwn(o,k))throw new TypeError('patch parent changed or removed'); if(!plain(o[k]))throw new TypeError('patch parent is not an object');o=o[k];}
 const k=path.at(-1);if(state.exists)o[k]=structuredClone(state.value);else delete o[k];
}
/**
 * Plan key-level changes only if the complete private base hash matches. Changes
 * are {path:string[], value:JSON} or {path:string[], unset:true}. Receipt contains
 * private old values for rollback and must be stored as sensitive (0600).
 * @returns {{config:object,receipt:object}} does not write or mutate the input
 */
export function planPatch(config,changes,baseHash) {
 if(fingerprint(config)!==baseHash)throw new Error('config drift: base hash mismatch');
 if(!Array.isArray(changes))throw new TypeError('changes must be an array');
 const paths=[];
 for(const c of changes) {
  if(!plain(c)||Object.keys(c).some(k=>!['path','value','unset'].includes(k)))throw new TypeError('invalid change');
  validPath(c.path);
  if(c.unset===true?Object.hasOwn(c,'value'):!Object.hasOwn(c,'value')||c.unset!==undefined)throw new TypeError('change must set or unset');
  const parts=c.path;
  if(paths.some(p=>p.every((k,i)=>parts[i]===k)||parts.every((k,i)=>p[i]===k)))throw new TypeError('overlapping patch paths');
  paths.push(parts);
 }
 const next=structuredClone(config),owned=[];
 for(const c of changes) {
  const before=locate(next,c.path),after=c.unset?{exists:false}:{exists:true,value:structuredClone(c.value)};
  if(after.exists)fingerprint(after.value);
  // Replacing a previously absent nested parent would make rollback ambiguous.
  if(c.path.length>1&&!locate(next,c.path.slice(0,-1)).exists) throw new TypeError('patch parent must already exist');
  put(next,c.path,after);owned.push({path:[...c.path],before,after});
 }
 return {config:next,receipt:{version:1,baseHash,patchedHash:fingerprint(next),changes:owned}};
}
/** Restore only receipt-owned keys; independent later config edits survive. */
export function rollbackPatch(current,receipt) {
 fingerprint(current);
 if(!receipt||receipt.version!==1||!Array.isArray(receipt.changes))throw new TypeError('invalid receipt');
 const next=structuredClone(current);
 for(const c of receipt.changes) {validPath(c.path);if(fingerprint(locate(current,c.path))!==fingerprint(c.after))throw new Error('owned key changed; rollback rejected');}
 for(const c of receipt.changes)put(next,c.path,c.before);
 return next;
}
