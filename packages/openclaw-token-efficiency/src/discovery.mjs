import { DatabaseSync } from 'node:sqlite';
import { readFileSync,statSync,existsSync,openSync,closeSync,fstatSync,readSync,mkdtempSync,writeSync,unlinkSync,chmodSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { normalizeUsage,readField } from './usage.mjs';
const identifier=x=>typeof x==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(x);
const quote=x=>{if(!identifier(x))throw new TypeError('unsupported SQL identifier');return `"${x}"`;};
function inspect(source) {
 const reasons=[];
 if(source?.incognito===true || source?.conversationAccess!==true)return {status:'excluded',reasons:['conversation access excluded (explicit opt-in required)']};
 if(!source||typeof source.id!=='string'||!source.id.length||typeof source.path!=='string'||!source.path.length)return {status:'unsupported',reasons:['unsupported source identity/path']};
 if(!['jsonl','sqlite'].includes(source.type))reasons.push('unsupported source type');
 if(!source.mapping||typeof source.mapping!=='object')reasons.push('unsupported source: explicit usage mapping required');
 else try {normalizeUsage({},source.mapping);}catch{reasons.push('unsupported usage mapping');}
 if(source.type==='jsonl'&&!source.mapping?.metadata?.sourceRecordKey)reasons.push('unsupported JSONL source: stable sourceRecordKey mapping required');
 if(source.type==='sqlite') {
  const c=source.columns;
  if(!identifier(source.table)||!c||!Array.isArray(c.keys)||!c.keys.length||c.keys.some(k=>!identifier(k))||(!c.json&&!c.zstd)||[c.json,c.zstd,c.sessionId,c.agentId].filter(x=>x!==undefined).some(x=>!identifier(x)))reasons.push('unsupported SQLite schema: explicit table, keys and JSON/zstd columns required');
  if(c&&Object.keys(c).some(k=>!['keys','json','zstd','sessionId','agentId'].includes(k)))reasons.push('unsupported SQLite column control');
 }
 if(source.privacy!==undefined&&(!source.privacy||typeof source.privacy!=='object'||Object.keys(source.privacy).some(k=>!['incognitoField','conversationAccessField'].includes(k))))reasons.push('unsupported privacy mapping');
 for(const k of ['maxBytes','maxRecordBytes'])if(source[k]!==undefined&&(!Number.isSafeInteger(source[k])||source[k]<1))reasons.push('unsupported source size bound');
 return {status:reasons.length?'unsupported':'supported',reasons};
}
/**
 * Discover only deployment.sources; never scan home directories. A source needs
 * explicit conversationAccess:true. Unsupported schemas are coverage gaps.
 * @param {{sources?:object[]}} deployment
 * @returns {{sources:object[],coverage:object}}
 */
export function discoverSources(deployment={}) {
 if(deployment.sources!==undefined&&!Array.isArray(deployment.sources))throw new TypeError('deployment.sources must be an array');
 const seen=new Set();
 const sources=(deployment.sources??[]).map(s=>{
  const result=inspect(s);
  if(seen.has(s?.id)){result.status='unsupported';result.reasons.push('duplicate source id');}seen.add(s?.id);
  return {...s,...result};
 });
 const reasons=sources.flatMap(s=>s.reasons);
 if(!sources.length)reasons.push('no explicitly configured sources');
 return {sources,coverage:{status:sources.length&&sources.every(s=>s.status==='supported')?'configured':'unknown',reasons}};
}
// These helpers use filesystem reads only. SQLite must never open source paths:
// readOnly/query_only can still create or modify WAL coordination sidecars.
const snapshotHint='provide consistent checkpointed rollback-journal snapshot';
const sameVersion=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
function readBoundedSqlite(path,maxBytes) {
 const fd=openSync(path,'r');
 try {
  const before=fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.size>BigInt(maxBytes))return {reason:'source exceeds configured size bound'};
  const bytes=Buffer.alloc(Number(before.size));let offset=0;
  while(offset<bytes.length) {const n=readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)break;offset+=n;}
  const grew=readSync(fd,Buffer.alloc(1),0,1,null)>0;
  const after=fstatSync(fd,{bigint:true});
  if(grew||offset!==bytes.length||!sameVersion(before,after))return {reason:'SQLite source changed during snapshot'};
  return {bytes,version:after};
 }finally {closeSync(fd);}
}
function snapshotSqlite(path,maxBytes) {
 const sidecars=()=>['-wal','-shm','-journal'].some(suffix=>existsSync(path+suffix));
 const unsupported=()=>({status:'unsupported',reason:`SQLite WAL/journal coordination unsupported without source writes; ${snapshotHint}`});
 if(sidecars())return unsupported();
 const first=readBoundedSqlite(path,maxBytes);
 if(first.reason)return {status:'degraded',reason:`${first.reason}; ${snapshotHint}`};
 if(first.bytes[18]===2||first.bytes[19]===2)return unsupported();
 const second=readBoundedSqlite(path,maxBytes);
 if(sidecars())return unsupported();
 if(second.reason||!sameVersion(first.version,second.version)||!first.bytes.equals(second.bytes)||!sameVersion(second.version,statSync(path,{bigint:true})))return {status:'degraded',reason:`SQLite source changed during snapshot; ${snapshotHint}`};
 return {bytes:first.bytes};
}
function privacyExcluded(raw,source) {
 const p=source.privacy??{};
 return raw.incognito===true||raw.conversationAccess===false || p.incognitoField!==undefined&&readField(raw,p.incognitoField)===true || p.conversationAccessField!==undefined&&readField(raw,p.conversationAccessField)===false;
}
/**
 * Full read-only rescan of one explicit generic source. JSONL records use the
 * configured mapping. SQLite requires a table, stable key columns, JSON/zstd
 * event columns and optional attribution columns; no host schema is guessed.
 * Only stable rollback-journal files without sidecars use an unlinked inode; WAL
 * and active journal sources are unsupported, never read as main-file-only data.
 * Returns usage projections and hash cursor only, never message bodies. Pass
 * events + reasons to ledger.ingest(...,{reconcile:true}) to reconcile old seqs.
 * @param {object} source
 * @returns {{source:string,status:string,events:object[],cursor:string|null,reasons:string[],excluded:number,fullRescan:boolean}}
 */
export function collectSource(source) {
 const checked=inspect(source);
 const result={source:source?.id??'unknown',status:checked.status==='supported'?'complete':checked.status,events:[],cursor:null,reasons:[...checked.reasons],excluded:0,fullRescan:true};
 if(checked.status!=='supported')return result;
 let db,snapshotDirectory,snapshotFd;
 const degrade=reason=>{result.status='degraded';if(!result.reasons.includes(reason))result.reasons.push(reason);};
 const project=(raw,key,attribution={})=>{
  try {
   if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new TypeError('record object required');
   if(privacyExcluded(raw,source)){result.excluded++;return;}
   const e=normalizeUsage(raw,source.mapping);
   if(key!==undefined)e.sourceRecordKey=key;
   for(const [k,v]of Object.entries(attribution))if(v!==null&&v!==undefined){if(typeof v!=='string')throw new TypeError('attribution must be string');e[k]=v;}
   if(!e.sourceRecordKey)throw new TypeError('missing source key');
   result.events.push(e);
  } catch {degrade('invalid record/mapping; usage unavailable');}
 };
 try {
  const stat=statSync(source.path);
  if(!stat.isFile())throw Object.assign(new Error('not file'),{code:'ENOTFILE'});
  if((stat.mode&0o444)===0)throw Object.assign(new Error('permission denied'),{code:'EACCES'});
  const maxBytes=source.maxBytes??64*1024*1024,maxRecordBytes=source.maxRecordBytes??2*1024*1024;
  if(stat.size>maxBytes){degrade('source exceeds configured size bound');return result;}
  if(source.type==='jsonl') {
   const bytes=readFileSync(source.path);result.cursor=createHash('sha256').update(bytes).digest('hex');
   for(const line of bytes.toString('utf8').split(/\r?\n/)) {
    if(!line.trim())continue;
    if(Buffer.byteLength(line)>maxRecordBytes){degrade('record exceeds configured size bound');continue;}
    try {project(JSON.parse(line));}catch{degrade('JSON decode failed; usage unavailable');}
   }
  }else {
   const snapshot=snapshotSqlite(source.path,maxBytes);
   if(snapshot.reason){result.status=snapshot.status;result.reasons.push(snapshot.reason);return result;}
   snapshotDirectory=mkdtempSync(join(tmpdir(),'ato-sqlite-copy-'));chmodSync(snapshotDirectory,0o700);
   const privatePath=join(snapshotDirectory,'snapshot.sqlite');
   // Open an empty owned file, then remove its name BEFORE writing raw bytes.
   // SQLite and this separate fd pin the same anonymous inode. A killed process
   // releases both fds without leaving a body-bearing file behind. Platforms
   // unable to unlink open SQLite files are unsupported; no named-copy fallback.
   try {
    snapshotFd=openSync(privatePath,'wx+',0o600);
    db=new DatabaseSync(privatePath,{readOnly:true});
    unlinkSync(privatePath);
    if(fstatSync(snapshotFd).nlink!==0)throw new Error('snapshot inode is still linked');
   }catch {result.status='unsupported';result.reasons.push('anonymous SQLite collection unsupported: cannot open/unlink empty file before raw bytes');return result;}
   let written=0;
   while(written<snapshot.bytes.length) {
    const n=writeSync(snapshotFd,snapshot.bytes,written,snapshot.bytes.length-written,null);
    if(n<=0)throw new Error('anonymous SQLite write made no progress');
    written+=n;
   }
   closeSync(snapshotFd);snapshotFd=undefined;
   db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
   const table=quote(source.table),cols=source.columns;
   const existing=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
   const needed=[...new Set([...cols.keys,cols.json,cols.zstd,cols.agentId,cols.sessionId].filter(Boolean))];
   if(!needed.every(k=>existing.has(k))){result.status='unsupported';result.reasons.push('unsupported SQLite schema: configured columns absent');return result;}
   const rows=db.prepare(`SELECT ${needed.map(quote).join(',')} FROM ${table} ORDER BY ${cols.keys.map(quote).join(',')}`).iterate();
   const hash=createHash('sha256');let consumed=0;
   for(const row of rows) {
    const keys=cols.keys.map(k=>row[k]);
    if(keys.some(k=>k===null||!['string','number','bigint'].includes(typeof k))){degrade('invalid stable SQLite record key');continue;}
    const key=JSON.stringify(keys.map(k=>typeof k==='bigint'?k.toString():k));
    try {
     let bytes=cols.json?row[cols.json]:null;
     const compressed=(bytes===null||bytes===undefined)&&cols.zstd?row[cols.zstd]:null;
     if(bytes===null||bytes===undefined) {
      if(compressed===null||compressed===undefined)throw new TypeError('missing event payload');
      if(typeof zlib.zstdDecompressSync!=='function'){degrade('zstd unsupported by this Node runtime');continue;}
      bytes=zlib.zstdDecompressSync(compressed,{maxOutputLength:maxRecordBytes});
     }
     if(typeof bytes!=='string'&&!ArrayBuffer.isView(bytes))throw new TypeError('invalid event payload');
     bytes=Buffer.from(bytes); consumed+=bytes.length;
     if(bytes.length>maxRecordBytes||consumed>maxBytes){degrade('source/record exceeds configured size bound');break;}
     hash.update(key).update(bytes);
     const attribution={};for(const k of ['agentId','sessionId'])if(cols[k])attribution[k]=row[cols[k]];
     project(JSON.parse(bytes.toString('utf8')),key,attribution);
    }catch{degrade('SQLite JSON/zstd decode failed; usage unavailable');}
   }
   result.cursor=hash.digest('hex');db.exec('ROLLBACK');
  }
 }catch(error){degrade(error.code==='EACCES'||error.code==='EPERM'?'source permission denied':'source read failed; usage unavailable');}
 finally{try{db?.close();}finally{try{if(snapshotFd!==undefined)closeSync(snapshotFd);}finally{if(snapshotDirectory)rmSync(snapshotDirectory,{recursive:true,force:true});}}}
 // A successful empty scan is still unknown provider coverage, never zero usage.
 if(!result.events.length&&result.status==='complete') {result.status='unknown';result.reasons.push(result.excluded?'all records excluded by privacy policy':'no usage records observed');}
 return result;
}
