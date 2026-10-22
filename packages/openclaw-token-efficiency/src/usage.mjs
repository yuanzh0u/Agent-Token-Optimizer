/** Provider-reported usage dimensions. Null means unavailable, never estimated zero. */
export const DIMENSIONS = Object.freeze(['uncachedInput','output','cacheRead','cacheWrite']);
/** Metadata allowlist; UsageEvent never includes prompt/response/message bodies. */
export const METADATA_FIELDS = Object.freeze(['sourceRecordKey','provider','model','accountId','requestId','agentId','sessionId','runId','runtime','workClass','timestamp','contentHash']);
const forbidden = new Set(['__proto__','prototype','constructor']);
/** @param {unknown} value @param {string} label @returns {number|null} */
export function tokenCount(value,label='token count') {
 if(value===null || value===undefined) return null;
 if(!Number.isSafeInteger(value)||value<0) throw new TypeError(`${label} must be a nonnegative safe integer or null`);
 return value;
}
/** Read an own-property field path; source schema is always explicit. */
export function readField(raw,path) {
 if(typeof path!=='string'||!path.length||path.split('.').some(x=>forbidden.has(x))) throw new TypeError('invalid mapping field path');
 return path.split('.').reduce((o,k)=>o && typeof o==='object' && Object.hasOwn(o,k) ? o[k] : undefined,raw);
}
/**
 * @typedef {object} UsageEvent
 * @property {number|null} uncachedInput
 * @property {number|null} output
 * @property {number|null} cacheRead
 * @property {number|null} cacheWrite
 * @property {string} [sourceRecordKey]
 * @property {string} [provider]
 * @property {string} [accountId]
 * @property {string} [requestId]
 */
/**
 * Normalize explicit provider field mappings. inputIncludesCacheRead and
 * inputIncludesCacheWrite are mandatory booleans; provider names have no semantics.
 * @param {object} raw source record (discarded after projection)
 * @param {{fields:object,inputIncludesCacheRead:boolean,inputIncludesCacheWrite:boolean,metadata?:object}} mapping
 * @returns {UsageEvent}
 */
export function normalizeUsage(raw,mapping) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new TypeError('usage must be an object');
 if(!mapping||typeof mapping.inputIncludesCacheRead!=='boolean'||typeof mapping.inputIncludesCacheWrite!=='boolean') throw new TypeError('explicit input cache semantics required');
 const fields=mapping.fields;
 if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).some(k=>!['input','output','cacheRead','cacheWrite'].includes(k))) throw new TypeError('invalid usage mapping');
 if(Object.keys(mapping).some(k=>!['fields','inputIncludesCacheRead','inputIncludesCacheWrite','metadata'].includes(k))) throw new TypeError('unknown usage mapping control');
 const get=k=>tokenCount(fields[k]===undefined?null:readField(raw,fields[k]),k);
 const input=get('input'), cacheRead=get('cacheRead'),cacheWrite=get('cacheWrite'),output=get('output');
 let uncachedInput=input;
 for(const [included,count] of [[mapping.inputIncludesCacheRead,cacheRead],[mapping.inputIncludesCacheWrite,cacheWrite]]) {
  if(included) uncachedInput=uncachedInput===null||count===null?null:uncachedInput-count;
 }
 if(uncachedInput!==null&&uncachedInput<0) throw new TypeError('negative uncached input after cache subtraction');
 const result={uncachedInput,output,cacheRead,cacheWrite};
 const metadata=mapping.metadata??{};
 if(typeof metadata!=='object'||Array.isArray(metadata)) throw new TypeError('invalid metadata mapping');
 for(const [key,path] of Object.entries(metadata)) {
  if(!METADATA_FIELDS.includes(key)) throw new TypeError(`unapproved metadata mapping: ${key}`);
  const value=readField(raw,path);
  if(value!==undefined&&value!==null) {
   if(typeof value!=='string'||value.length>1024||value.includes('\u0000')) throw new TypeError(`invalid metadata ${key}`);
   result[key]=value;
  }
 }
 return result;
}
