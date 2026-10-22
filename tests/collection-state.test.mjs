import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,statSync,linkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {UsageLedger,readReport,writeReport} from '../packages/openclaw-token-efficiency/src/index.mjs';
import {collectDeployment,loadDeployment} from '../src/collector.mjs';

const mapping={fields:{input:'usage.input',output:'usage.output',cacheRead:'usage.cacheRead',cacheWrite:'usage.cacheWrite'},inputIncludesCacheRead:false,inputIncludesCacheWrite:false,metadata:Object.fromEntries(['sourceRecordKey','provider','accountId','requestId','agentId','sessionId','runId','runtime'].map(k=>[k,k]))};
const record=(id,output=2)=>({sourceRecordKey:id,provider:'fixture',accountId:'synthetic-account',requestId:id,agentId:'opaque',sessionId:'s',runId:'r',runtime:'fixture',usage:{input:10,output,cacheRead:0,cacheWrite:0},prompt:'NEVER-STORE-RAW'});
function temporary(t){const dir=mkdtempSync(join(tmpdir(),'ato-collection-state-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function setup(t){const dir=temporary(t),path=join(dir,'deployment.json'),config={version:1,policy:'policy.json',ledger:'state/usage.sqlite',reportDirectory:'reports',sources:['a','b'].map(id=>({id,type:'jsonl',path:id+'.jsonl',conversationAccess:true,mapping}))};writeFileSync(join(dir,'policy.json'),'{}');for(const id of ['a','b'])writeFileSync(join(dir,id+'.jsonl'),JSON.stringify(record(id))+'\n');const save=()=>writeFileSync(path,JSON.stringify(config));save();return {dir,path,config,save};}
function cliReport(path){const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',resolve('bin/agent-token-optimizer.mjs'),'report','--config',path],{encoding:'utf8',timeout:10000});return {code:child.status,value:JSON.parse(child.stdout)};}
test('collection failure stays stale across independent CLI reads until recovery publishes; snapshot bytes survive',async t=>{
 const s=setup(t),first=await collectDeployment(s.path);assert.equal(first.report.status,'fresh');const json=readFileSync(first.report.paths.json),html=readFileSync(first.report.paths.html);
 rmSync(join(s.dir,'a.jsonl'));rmSync(join(s.dir,'b.jsonl'));const failed=await collectDeployment(s.path);assert.equal(failed.report.status,'stale');
 assert.deepEqual(readFileSync(first.report.paths.json),json);assert.deepEqual(readFileSync(first.report.paths.html),html);
 let read=cliReport(s.path);assert.equal(read.code,2);assert.equal(read.value.status,'stale');assert.equal(read.value.collectionHealth.status,'failed');
 assert.equal(readReport(join(s.dir,'reports')).status,'stale');
 const health=readFileSync(join(s.dir,'reports/collection-health.json'),'utf8');assert.ok(!health.includes('NEVER-STORE-RAW'));assert.ok(!health.includes('jsonl'));assert.equal(statSync(join(s.dir,'reports/collection-health.json')).mode&0o777,0o600);
 for(const id of ['a','b'])writeFileSync(join(s.dir,id+'.jsonl'),JSON.stringify(record(id))+'\n');const recovered=await collectDeployment(s.path);assert.equal(recovered.report.status,'fresh');read=cliReport(s.path);assert.equal(read.code,0);assert.equal(read.value.status,'fresh');assert.equal(read.value.collectionHealth.status,'healthy');
 assert.match(readFileSync(first.report.paths.html,'utf8'),/Saved snapshot age/);assert.match(readFileSync(first.report.paths.html,'utf8'),/does not observe later collection failures/);
});
test('pending/missing/corrupt or mismatched health cannot make a saved snapshot healthy',async t=>{
 const s=setup(t),first=await collectDeployment(s.path),path=join(s.dir,'reports/collection-health.json');
 const healthy=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{},saved=readFileSync(first.report.paths.json);
 for(const state of [null,'{bad',JSON.stringify({...healthy,status:'collecting'}),JSON.stringify({...healthy,publicationId:'wrong'})]){
  if(state===null)rmSync(path,{force:true});else writeFileSync(path,state);
  assert.equal(readReport(join(s.dir,'reports')).status,'stale');assert.equal(cliReport(s.path).code,2);
 }
 await writeReport({directory:join(s.dir,'reports'),collect:()=>{throw new Error('NEVER-STORE-RAW');}});assert.ok(!readFileSync(path,'utf8').includes('NEVER-STORE-RAW'));assert.deepEqual(readFileSync(first.report.paths.json),saved);
});
test('current source scope excludes removed sources across reopen and detects changed inactive records on re-add',async t=>{
 const s=setup(t);assert.equal((await collectDeployment(s.path)).report.snapshot.summary.globalComplete,true);
 const b=s.config.sources.pop();s.save();let current=await collectDeployment(s.path);
 assert.deepEqual(current.report.snapshot.summary.perSource.map(x=>x.source),['a']);assert.equal(current.report.snapshot.summary.global.totals.output,2);
 assert.deepEqual(current.report.snapshot.summary.sourceScope,{kind:'deployment',activeSources:['a'],inactiveSources:['b'],inactiveRecordCount:1});
 writeFileSync(join(s.dir,'b.jsonl'),JSON.stringify(record('b',500))+'\n');current=await collectDeployment(s.path);assert.equal(current.report.snapshot.summary.global.totals.output,2);
 let ledger=new UsageLedger(join(s.dir,'state/usage.sqlite'));assert.deepEqual(ledger.summary().perSource.map(x=>x.source),['a']);assert.equal(ledger.getCursor('b')!==null,true);ledger.close();
 s.config.sources.push(b);s.save();current=await collectDeployment(s.path);assert.equal(current.report.status,'degraded');assert.equal(current.report.snapshot.summary.globalComplete,false);assert.equal(current.report.snapshot.summary.quarantined,1);assert.match(current.report.snapshot.summary.coverage.reasons.join(' '),/rewrite/);
 const db=new DatabaseSync(join(s.dir,'state/usage.sqlite'),{readOnly:true});const old=JSON.parse(db.prepare("SELECT payload FROM records WHERE source='b'").get().payload);assert.equal(old.output,2);db.close();
});
test('re-added source is actually rescanned for appended records; unrelated plugin observations stay outside explicit scope',async t=>{
 const s=setup(t);await collectDeployment(s.path);const b=s.config.sources.pop();s.save();await collectDeployment(s.path);
 let ledger=new UsageLedger(join(s.dir,'state/usage.sqlite'));ledger.ingest([{sourceRecordKey:'delivery',uncachedInput:5,output:1,cacheRead:0,cacheWrite:0}],{source:'openclaw-llm-output',reasons:['attempt aggregate']});ledger.close();
 writeFileSync(join(s.dir,'b.jsonl'),JSON.stringify(record('b'))+'\n'+JSON.stringify(record('b-late',3))+'\n');s.config.sources.push(b);s.save();const current=await collectDeployment(s.path),summary=current.report.snapshot.summary;
 assert.deepEqual(summary.perSource.map(x=>x.source),['a','b']);assert.equal(summary.global.totals.output,7);assert.equal(summary.globalComplete,true);assert.equal(summary.sourceScope.kind,'deployment');assert.deepEqual(summary.sourceScope.inactiveSources,['openclaw-llm-output']);
 ledger=new UsageLedger(join(s.dir,'state/usage.sqlite'));assert.equal(ledger.summary().global.totals.output,7);assert.equal(ledger.summary().sourceScope.inactiveRecordCount,1);ledger.close();
 const plugin=new UsageLedger(join(s.dir,'plugin/usage.sqlite'));plugin.ingest([{sourceRecordKey:'p',output:1}],{source:'openclaw-llm-output',reasons:['attempt aggregate']});assert.equal(plugin.summary().sourceScope.kind,'all-observations');assert.equal(plugin.summary().globalComplete,false);plugin.close();
});
test('collection health path joins protected aliases, including ledger sidecars, before any state writes',t=>{
 for(const target of ['source','config','policy','ledger','-journal','-wal','-shm','report.json','report.html'])for(const kind of ['hardlink','symlink']){
  const s=setup(t);mkdirSync(join(s.dir,'reports'));const health=join(s.dir,'reports/collection-health.json');writeFileSync(health,'{"private":"MUST-PRESERVE"}');let alias;
  if(target==='source')alias=join(s.dir,'a.jsonl');else if(target==='config')alias=s.path;else if(target==='policy')alias=join(s.dir,'policy.json');else if(target==='ledger')alias=join(s.dir,'state/usage.sqlite');else if(target.startsWith('-'))alias=join(s.dir,'state/usage.sqlite'+target);else alias=join(s.dir,'reports',target);
  mkdirSync(resolve(alias,'..'),{recursive:true});rmSync(alias,{force:true});if(kind==='hardlink')linkSync(health,alias);else symlinkSync(health,alias);
  if(target==='config')writeFileSync(health,JSON.stringify(s.config));const before=readFileSync(health);
  assert.throws(()=>loadDeployment(s.path),/alias|overlap/);assert.deepEqual(readFileSync(health),before);
 }
});
test('direct report health symlinks are refused without touching their target',async t=>{
 const dir=temporary(t),report=join(dir,'report'),target=join(dir,'unrelated');mkdirSync(report);writeFileSync(target,'MUST-PRESERVE');symlinkSync(target,join(report,'collection-health.json'));
 await assert.rejects(writeReport({directory:report,collect:()=>{throw new Error('raw');}}),/owned|symlink|alias/);assert.equal(readFileSync(target,'utf8'),'MUST-PRESERVE');
});
test('exact v1 ledger upgrades to scoped v2 without losing audit records',t=>{
 const dir=temporary(t),path=join(dir,'legacy.sqlite'),db=new DatabaseSync(path);
 db.exec('CREATE TABLE records(source TEXT NOT NULL, record_key TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL, shared_key TEXT, quarantined INTEGER NOT NULL DEFAULT 0, reason TEXT, PRIMARY KEY(source,record_key)); CREATE TABLE sources(source TEXT PRIMARY KEY, cursor TEXT NOT NULL, reasons TEXT NOT NULL); PRAGMA application_id=1096044337; PRAGMA user_version=1');
 db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run('old','one',JSON.stringify({sourceRecordKey:'one',uncachedInput:1,output:2,cacheRead:0,cacheWrite:0}),'old-hash',null,0,null);db.prepare('INSERT INTO sources VALUES(?,?,?)').run('old','null','[]');db.close();
 let ledger=new UsageLedger(path);assert.equal(typeof ledger.setSourceScope,'function');assert.equal(ledger.summary().perSource[0].eventCount,1);ledger.setSourceScope([]);assert.deepEqual(ledger.summary().perSource,[]);ledger.close();
 ledger=new UsageLedger(path);assert.deepEqual(ledger.summary().sourceScope.inactiveSources,['old']);ledger.setSourceScope(['old']);assert.equal(ledger.summary().perSource[0].eventCount,1);ledger.close();
 const check=new DatabaseSync(path,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get().user_version,2);assert.equal(check.prepare('SELECT count(*) AS n FROM records').get().n,1);check.close();
});
