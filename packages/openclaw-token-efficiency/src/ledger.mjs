import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,chmodSync,lstatSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { DIMENSIONS,METADATA_FIELDS,tokenCount } from './usage.mjs';
import { fingerprint } from './drift.mjs';
import {preflightLedger,assertPreflightUnchanged,noLedgerSidecars,assertLedgerSchema,LEDGER_SCHEMAS,SCOPE_SCHEMA} from './ledger-preflight.mjs';
const empty=()=>Object.fromEntries(DIMENSIONS.map(k=>[k,null]));
const sharedKey=e=>['provider','accountId','requestId'].every(k=>typeof e[k]==='string'&&e[k].length)?JSON.stringify([e.provider,e.accountId,e.requestId]):null;
const signature=e=>fingerprint(Object.fromEntries([...DIMENSIONS,'provider','model','accountId','requestId','agentId','sessionId','runId','runtime','workClass'].map(k=>[k,e[k]??null])));
function sourceIds(ids){if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id.length||id.length>1024||id.includes('\0'))||new Set(ids).size!==ids.length)throw new TypeError('unique source IDs required');return [...ids].sort();}
function sanitize(event) {
 if(!event||typeof event!=='object'||Array.isArray(event)||Object.keys(event).some(k=>![...METADATA_FIELDS,...DIMENSIONS,'localEstimates'].includes(k)))throw new TypeError('unapproved event metadata/field');
 const out={};
 for(const k of DIMENSIONS)out[k]=tokenCount(event[k],k);
 for(const k of METADATA_FIELDS)if(event[k]!==undefined&&event[k]!==null){if(typeof event[k]!=='string'||!event[k].length||event[k].length>1024||event[k].includes('\u0000'))throw new TypeError(`invalid event ${k}`);out[k]=event[k];}
 if(!out.sourceRecordKey)throw new TypeError('sourceRecordKey required');
 if(event.localEstimates!==undefined) {
  if(!event.localEstimates||typeof event.localEstimates!=='object'||Array.isArray(event.localEstimates)||Object.keys(event.localEstimates).some(k=>!DIMENSIONS.includes(k)))throw new TypeError('invalid local estimates');
  out.localEstimates=Object.fromEntries(DIMENSIONS.map(k=>[k,tokenCount(event.localEstimates[k],k)]));
 }
 return out;
}
function aggregate(events,degraded=false) {
 const knownTotals=Object.fromEntries(DIMENSIONS.map(k=>[k,0])),knownCounts={...knownTotals};
 for(const e of events)for(const k of DIMENSIONS)if(e[k]!==null&&e[k]!==undefined){knownTotals[k]+=e[k];knownCounts[k]++;if(!Number.isSafeInteger(knownTotals[k]))throw new RangeError('usage total exceeds safe integer');}
 return {eventCount:events.length,totals:Object.fromEntries(DIMENSIONS.map(k=>[k,!degraded&&events.length&&knownCounts[k]===events.length?knownTotals[k]:null])),knownTotals,knownCounts};
}
/**
 * Independent SQLite usage ledger. Sources are never opened for writes. All
 * batches and cursors commit together; conflicts permanently quarantine every
 * related copy rather than preserving a falsely authoritative first record.
 */
export class UsageLedger {
 #db; #closed=false;
 /** @param {string} path private ledger file (not a source path) */
 constructor(path) {
  if(typeof path!=='string'||!path.length||path===':memory:')throw new TypeError('private ledger path required');
  const absolute=resolve(path),directory=dirname(absolute);
  mkdirSync(directory,{recursive:true,mode:0o700});
  for(const p of [directory,...lstatSync(absolute,{throwIfNoEntry:false})?[absolute]:[]]) {const s=lstatSync(p);if(s.isSymbolicLink()||typeof process.getuid==='function'&&s.uid!==process.getuid())throw new Error('ledger state must be independently owned, without symlinks');}
  const version=preflightLedger(absolute),existed=version!==null,previous=process.umask(0o077);
  try {
   assertPreflightUnchanged(absolute,version);
   this.#db=new DatabaseSync(absolute);
   // Recheck at the writable boundary; unsupported recovery never gets a schema
   // read on the original DB. This state must have one independent writer.
   noLedgerSidecars(absolute);const schemaVersion=assertLedgerSchema(this.#db,existed);
   this.#db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
   try {
    if(!existed)for(const [,sql]of LEDGER_SCHEMAS)this.#db.exec(sql);
    else if(schemaVersion<2)this.#db.exec(SCOPE_SCHEMA[1]);
    this.#db.exec('PRAGMA application_id=1096044337; PRAGMA user_version=2; COMMIT');
   }catch(error){this.#db.exec('ROLLBACK');throw error;}
   chmodSync(directory,0o700);chmodSync(absolute,0o600);
  }catch(error){this.#db?.close();throw error;}finally{process.umask(previous);}
 }
 #open(){if(this.#closed)throw new Error('ledger is closed');}
 /**
  * @param {object[]} events sanitized UsageEvents
  * @param {{source:string,cursor:unknown,reconcile?:boolean,reasons?:string[]}} options
  * reconcile=true marks missing records during a full source rescan as degraded.
  */
 ingest(events,{source,cursor=null,reconcile=false,reasons=[]}={}) {
  this.#open();
  if(typeof source!=='string'||!source.length||source.length>1024)throw new TypeError('source required');
  if(!Array.isArray(events)||!Array.isArray(reasons)||reasons.some(x=>typeof x!=='string'))throw new TypeError('invalid ingest batch');
  const incoming=events.map(sanitize),cursorJson=JSON.stringify(cursor);if(cursorJson===undefined)throw new TypeError('invalid cursor');fingerprint(cursor);
  this.#db.exec('BEGIN IMMEDIATE');
  try {
   const seen=new Set();
   const quarantine=this.#db.prepare('UPDATE records SET quarantined=1,reason=? WHERE shared_key=?');
   for(const e of incoming) {
    const key=e.sourceRecordKey,hash=fingerprint(e),shared=sharedKey(e);seen.add(key);
    const old=this.#db.prepare('SELECT * FROM records WHERE source=? AND record_key=?').get(source,key);
    if(old) {
     if(old.hash!==hash) {
      this.#db.prepare('UPDATE records SET quarantined=1,reason=? WHERE source=? AND record_key=?').run('in-place rewrite',source,key);
      if(old.shared_key)quarantine.run('in-place rewrite conflict',old.shared_key);
      if(shared)quarantine.run('in-place rewrite conflict',shared);
     }
     continue;
    }
    const peers=shared?this.#db.prepare('SELECT payload,quarantined FROM records WHERE shared_key=?').all(shared):[];
    const conflict=peers.some(p=>p.quarantined||signature(JSON.parse(p.payload))!==signature(e));
    this.#db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(source,key,JSON.stringify(e),hash,shared,conflict?1:0,conflict?'shared request identity/usage conflict':null);
    if(conflict)quarantine.run('shared request identity/usage conflict',shared);
   }
   if(reconcile)for(const row of this.#db.prepare('SELECT record_key,shared_key FROM records WHERE source=?').all(source))if(!seen.has(row.record_key)) {
    this.#db.prepare('UPDATE records SET quarantined=1,reason=? WHERE source=? AND record_key=?').run('record removed during full rescan',source,row.record_key);
    if(row.shared_key)quarantine.run('record removed during full rescan',row.shared_key);
   }
   this.#db.prepare('INSERT INTO sources VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,reasons=excluded.reasons').run(source,cursorJson,JSON.stringify([...new Set(reasons)]));
   const summary=this.summary();
   this.#db.exec('COMMIT');
   return summary;
  }catch(error){this.#db.exec('ROLLBACK');throw error;}
 }
 /** Persisted source cursor; it is diagnostic, never a substitute for reconciliation. */
 getCursor(source){this.#open();const row=this.#db.prepare('SELECT cursor FROM sources WHERE source=?').get(source);return row?JSON.parse(row.cursor):null;}
 /** Persist the exact deployment source set. Historical records are never
  * removed; unlisted sources (including observer deliveries) leave current totals. */
 setSourceScope(ids){
  this.#open();const active=sourceIds(ids);this.#db.exec('BEGIN IMMEDIATE');
  try{this.#db.prepare('INSERT INTO collection_scope VALUES(1,?) ON CONFLICT(id) DO UPDATE SET source_ids=excluded.source_ids').run(JSON.stringify(active));const result=this.summary();this.#db.exec('COMMIT');return result;}
  catch(error){this.#db.exec('ROLLBACK');throw error;}
 }
 /** Usage grouped by source and exact attribution, with explicit completeness and local estimates. */
 summary() {
  this.#open();
  const allRows=this.#db.prepare('SELECT * FROM records ORDER BY source,record_key').all().map(r=>({...r,event:JSON.parse(r.payload)}));
  const allSources=this.#db.prepare('SELECT * FROM sources ORDER BY source').all();
  const configured=this.#db.prepare('SELECT source_ids FROM collection_scope WHERE id=1').get();
  const activeSources=configured?sourceIds(JSON.parse(configured.source_ids)):allSources.map(s=>s.source),active=new Set(activeSources);
  const rows=allRows.filter(r=>active.has(r.source)),sources=allSources.filter(s=>active.has(s.source));
  const sourceScope={kind:configured?'deployment':'all-observations',activeSources,inactiveSources:allSources.filter(s=>!active.has(s.source)).map(s=>s.source),inactiveRecordCount:allRows.length-rows.length};
  const reasons=new Set(sources.flatMap(s=>JSON.parse(s.reasons))),perSource=[],groups=[];
  if(activeSources.some(id=>!sources.some(s=>s.source===id)))reasons.add('active source not observed in ledger');
  for(const row of rows)if(row.quarantined)reasons.add(row.reason);
  if(!rows.length)reasons.add('no observed records');
  for(const s of sources) {
   const all=rows.filter(r=>r.source===s.source),valid=all.filter(r=>!r.quarantined),bad=all.length-valid.length;
   const sourceReasons=JSON.parse(s.reasons),degraded=bad>0||sourceReasons.length>0;
   perSource.push({source:s.source,...aggregate(valid.map(r=>r.event),degraded),quarantinedCount:bad,cursor:JSON.parse(s.cursor),reasons:sourceReasons});
   const grouped=new Map();
   for(const r of valid) {
    const e=r.event,identity={agentId:e.agentId??`unknown:${JSON.stringify([s.source,e.sourceRecordKey])}`,sessionId:e.sessionId??null,runId:e.runId??null,runtime:e.runtime??null,provider:e.provider??null,model:e.model??null};
    const k=JSON.stringify(identity);if(!grouped.has(k))grouped.set(k,{identity,events:[]});grouped.get(k).events.push(e);
   }
   for(const g of grouped.values())groups.push({source:s.source,...g.identity,...aggregate(g.events,degraded)});
  }
  const unique=new Map();
  for(const r of rows.filter(r=>!r.quarantined)) {
   const e=r.event;
   if(!r.shared_key){reasons.add('missing shared provider/account/request identity: per-source totals only');continue;}
   if(DIMENSIONS.some(k=>e[k]===null)){reasons.add('unknown usage dimensions');continue;}
   if(['agentId','sessionId','runId','runtime'].some(k=>!e[k]))reasons.add('unknown attribution');
   unique.set(r.shared_key,e);
  }
  const globalComplete=reasons.size===0;
  return {schemaVersion:1,sourceScope,perSource,groups,global:{...aggregate([...unique.values()],!globalComplete)},globalComplete,quarantined:rows.filter(r=>r.quarantined).length,coverage:{status:globalComplete?'complete':rows.length?'degraded':'unknown',reasons:[...reasons]},localEstimates:aggregate(rows.filter(r=>!r.quarantined&&r.event.localEstimates).map(r=>r.event.localEstimates))};
 }
 /** Close SQLite explicitly; safe to call more than once. */
 close(){if(!this.#closed){this.#db.close();this.#closed=true;}}
}
