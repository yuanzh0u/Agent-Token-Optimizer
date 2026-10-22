import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {UsageLedger}=await import('../packages/openclaw-token-efficiency/src/ledger.mjs').catch(()=>({}));
const event=(key,extra={})=>({sourceRecordKey:key,provider:'p',accountId:'a',requestId:key,agentId:'opaque',sessionId:'s',runId:'r',runtime:'node',uncachedInput:140,output:15,cacheRead:900,cacheWrite:20,...extra});
function fixture(t){assert.equal(typeof UsageLedger,'function','ledger must exist');const dir=mkdtempSync(join(tmpdir(),'ato-ledger-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'state','usage.sqlite'); const db=new UsageLedger(path);t.after(()=>db.close());return {db,path};}
test('ledger survives restart/replay, deduplicates complete identities, and stores no bodies',t=>{
 const {db,path}=fixture(t);db.ingest([event('one')],{source:'jsonl',cursor:1});
 db.ingest([event('one')],{source:'jsonl',cursor:1});
 db.ingest([event('another-key',{requestId:'one'})],{source:'sqlite',cursor:3});
 let s=db.summary();assert.equal(s.globalComplete,true);assert.equal(s.global.eventCount,1);
 assert.deepEqual(s.global.totals,{uncachedInput:140,output:15,cacheRead:900,cacheWrite:20});
 assert.equal(s.perSource.length,2);assert.equal(db.getCursor('jsonl'),1);
 db.close();const reopened=new UsageLedger(path); t.after(()=>reopened.close());
 reopened.ingest([event('one')],{source:'jsonl',cursor:1});
 assert.equal(reopened.summary().global.eventCount,1);
 assert.equal(statSync(path).mode&0o777,0o600);assert.equal(statSync(join(path,'..')).mode&0o777,0o700);
 assert.ok(!readFileSync(path).includes(Buffer.from('prompt-body')));
});
test('invalid batch rolls back both earlier inserts and source cursor',t=>{
 const {db}=fixture(t);db.ingest([event('one')],{source:'a',cursor:1});
 assert.throws(()=>db.ingest([event('two'),event('bad',{output:-1})],{source:'a',cursor:8}));
 assert.equal(db.getCursor('a'),1);assert.equal(db.summary().global.eventCount,1);
 assert.throws(()=>db.ingest([event('body',{prompt:'prompt-body'})],{source:'a',cursor:9}),/metadata|field/);
 assert.equal(db.getCursor('a'),1);
});
test('cross-source conflicting counts quarantine every copy; authoritative totals become unavailable',t=>{
 const {db}=fixture(t);db.ingest([event('one')],{source:'a',cursor:1});
 db.ingest([event('two',{requestId:'one',output:16})],{source:'b',cursor:1});
 const s=db.summary();assert.equal(s.globalComplete,false);assert.equal(s.quarantined,2);
 assert.equal(s.global.totals.output,null);assert.match(s.coverage.reasons.join(' '),/conflict/);
 assert.equal(s.perSource[0].totals.uncachedInput,null);
});
test('cross-source identity conflict and changed old sequence remain quarantined after replay',t=>{
 const {db}=fixture(t);db.ingest([event('1')],{source:'a',cursor:1});
 db.ingest([event('2',{requestId:'1',agentId:'other'})],{source:'b',cursor:1});
 assert.equal(db.summary().quarantined,2);
 db.ingest([event('old')],{source:'c',cursor:99});
 db.ingest([event('old',{output:17})],{source:'c',cursor:99});
 db.ingest([event('old')],{source:'c',cursor:99});
 assert.equal(db.summary().quarantined,3);
 assert.match(db.summary().coverage.reasons.join(' '),/rewrit/);
});
test('unknown identities/counts isolate per-source totals and local estimates stay separate',t=>{
 const {db}=fixture(t);db.ingest([event('one',{requestId:undefined,agentId:undefined,output:null,localEstimates:{output:77}})],{source:'a',cursor:'late'});
 db.ingest([event('two',{requestId:undefined,agentId:undefined})],{source:'b',cursor:null});
 const s=db.summary();assert.equal(s.globalComplete,false);assert.equal(s.global.totals.output,null);
 assert.equal(s.perSource.find(x=>x.source==='a').totals.output,null);
 assert.equal(s.perSource.find(x=>x.source==='a').knownCounts.output,0);
 assert.equal(s.localEstimates.knownTotals.output,77);assert.equal(s.groups.length,2);
 assert.notEqual(s.groups[0].agentId,s.groups[1].agentId);
});
test('late records and new session IDs appear; full rescan detects deleted records',t=>{
 const {db}=fixture(t);db.ingest([event('1'),event('2',{sessionId:'new'})],{source:'a',cursor:99,reconcile:true});
 db.ingest([event('1'),event('2',{sessionId:'new'}),event('late')],{source:'a',cursor:99,reconcile:true});
 assert.equal(db.summary().global.eventCount,3); assert.equal(db.summary().groups.length,2);
 db.ingest([event('1')],{source:'a',cursor:99,reconcile:true});
 assert.equal(db.summary().quarantined,2);assert.equal(db.summary().globalComplete,false);
});
test('golden two-request sample replays to 140/15/900/20 across namespaced accounts',t=>{
 const {db}=fixture(t);
 const one=event('r1',{uncachedInput:100,output:10,cacheRead:900,cacheWrite:0}),two=event('r2',{uncachedInput:40,output:5,cacheRead:0,cacheWrite:20});
 db.ingest([one,one,two],{source:'golden',cursor:2});db.ingest([one,two],{source:'golden',cursor:2});
 assert.deepEqual(db.summary().global.totals,{uncachedInput:140,output:15,cacheRead:900,cacheWrite:20});
 db.ingest([event('r1',{accountId:'separate'})],{source:'other-account',cursor:1});
 db.ingest([event('r1',{provider:'other-provider'})],{source:'other-provider',cursor:1});
 assert.equal(db.summary().global.eventCount,4);assert.equal(db.summary().global.totals.uncachedInput,420);
});
test('aggregate overflow rolls back new records and cursor rather than failing after commit',t=>{
 const {db}=fixture(t);db.ingest([event('one',{uncachedInput:Number.MAX_SAFE_INTEGER})],{source:'a',cursor:1});
 assert.throws(()=>db.ingest([event('two',{uncachedInput:1})],{source:'a',cursor:2}),/safe integer/);
 assert.equal(db.getCursor('a'),1);assert.equal(db.summary().global.eventCount,1);
});
