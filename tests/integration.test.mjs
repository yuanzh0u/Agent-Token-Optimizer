import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {normalizeUsage,UsageLedger,writeReport,readReport} from '../packages/openclaw-token-efficiency/src/index.mjs';
const pipeline=await import('../src/collector.mjs').catch(()=>({}));
const observer=await import('../plugins/openclaw-token-governor/src/observer.mjs').catch(()=>({}));
const mapping={fields:{input:'usage.input',output:'usage.output',cacheRead:'usage.cacheRead',cacheWrite:'usage.cacheWrite'},inputIncludesCacheRead:false,inputIncludesCacheWrite:false,metadata:{sourceRecordKey:'id',provider:'provider',model:'model',agentId:'agentId'}};
const fixture=(id='one',model='<fixture-model>')=>({id,provider:'fixture',model,agentId:'arbitrary-renamed',usage:{input:10,output:2,cacheRead:3,cacheWrite:0},prompt:'SECRET-BODY'});
function temp(t){const dir=mkdtempSync(join(tmpdir(),'ato-integration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function setup(t){const dir=temp(t);writeFileSync(join(dir,'events.jsonl'),JSON.stringify(fixture())+'\n');const config={version:1,policy:'policy.json',ledger:'state/usage.sqlite',reportDirectory:'report',sources:[{id:'explicit',type:'jsonl',path:'events.jsonl',conversationAccess:true,mapping}]};writeFileSync(join(dir,'deploy.json'),JSON.stringify(config));return {dir,config,path:join(dir,'deploy.json')};}
test('model survives normalization, independent grouping, and escaped report projection',async t=>{
 const dir=temp(t),ledger=new UsageLedger(join(dir,'state/db'));
 t.after(()=>ledger.close());
 ledger.ingest([normalizeUsage(fixture('a','<model-a>'),mapping),normalizeUsage(fixture('b','model-b'),mapping)],{source:'fixture'});
 assert.deepEqual(ledger.summary().groups.map(g=>g.model).sort(),['<model-a>','model-b']);
 await writeReport({directory:join(dir,'report'),collect:()=>ledger.summary()});
 assert.equal(readReport(join(dir,'report')).snapshot.summary.groups[0].model,'<model-a>');
 assert.match(readFileSync(join(dir,'report/report.html'),'utf8'),/&lt;model-a&gt;/);
});
test('foreign and newer ledger schemas reject without changing their bytes',t=>{
 const dir=temp(t);
 for(const variant of ['foreign','newer','empty']){
  const path=join(dir,variant+'.sqlite'),db=new DatabaseSync(path);
  if(variant==='foreign')db.exec('CREATE TABLE foreign_data(secret TEXT); INSERT INTO foreign_data VALUES("fixture")'.replace('"fixture"',"'fixture'"));
  if(variant==='newer')db.exec('PRAGMA application_id=1096044337; PRAGMA user_version=99; CREATE TABLE records(x)');
  db.close(); const before=readFileSync(path);
  assert.throws(()=>new UsageLedger(path),/schema|ownership|foreign/i);
  assert.deepEqual(readFileSync(path),before);
 }
});
test('ledger refuses a dangling state symlink before creating its target',t=>{
 const dir=temp(t),path=join(dir,'alias.sqlite'),target=join(dir,'new-target.sqlite');symlinkSync(target,path);
 assert.throws(()=>new UsageLedger(path),/symlink|owned/i);assert.equal(existsSync(target),false);
});
test('collector reports stable state failure code without foreign content',async t=>{
 const s=setup(t);s.config.ledger='foreign.sqlite';writeFileSync(s.path,JSON.stringify(s.config));const db=new DatabaseSync(join(s.dir,'foreign.sqlite'));db.exec('CREATE TABLE private_data(secret TEXT)');db.close();
 const result=await pipeline.collectDeployment(s.path);assert.equal(result.ok,false);assert.equal(result.failureCode,'state-unavailable-or-unsupported-schema');assert.ok(!JSON.stringify(result).includes('private_data'));
});
test('exact legacy v0 ledger upgrades without losing records and reopens',t=>{
 const dir=temp(t),path=join(dir,'legacy.sqlite');
 let ledger=new UsageLedger(path);ledger.ingest([{sourceRecordKey:'x',uncachedInput:1,output:2,cacheRead:0,cacheWrite:0}],{source:'old'});ledger.close();
 const db=new DatabaseSync(path);db.exec('DROP TABLE IF EXISTS collection_scope; PRAGMA application_id=0; PRAGMA user_version=0');db.close();
 ledger=new UsageLedger(path);assert.equal(ledger.summary().perSource[0].eventCount,1);ledger.close();
 const check=new DatabaseSync(path,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get().user_version,2);assert.notEqual(check.prepare('PRAGMA application_id').get().application_id,0);check.close();
 ledger=new UsageLedger(path);ledger.close();
});
test('collector rescans explicit sources, retains stale report on total failure, and never reconciles incomplete scans',async t=>{
 assert.equal(typeof pipeline.collectDeployment,'function');const s=setup(t);
 let result=await pipeline.collectDeployment(s.path);assert.equal(result.ok,true);assert.equal(result.sources[0].status,'complete');
 const before=readFileSync(join(s.dir,'report/report.json'));
 rmSync(join(s.dir,'events.jsonl'));
 result=await pipeline.collectDeployment(s.path);assert.equal(result.ok,false);assert.equal(result.report.status,'stale');assert.deepEqual(readFileSync(join(s.dir,'report/report.json')),before);
 writeFileSync(join(s.dir,'events.jsonl'),JSON.stringify(fixture())+'\n{bad json}\n');
 result=await pipeline.collectDeployment(s.path);assert.equal(result.ok,true);assert.equal(result.sources[0].status,'degraded');assert.equal(result.report.snapshot.summary.quarantined,0);assert.equal(result.report.snapshot.summary.coverage.status,'degraded');
 assert.ok(!JSON.stringify(result).includes('SECRET-BODY'));
});
test('collector exposes failed/excluded sources alongside a successful source',async t=>{
 assert.equal(typeof pipeline.collectDeployment,'function');const s=setup(t);s.config.sources.push({...s.config.sources[0],id:'missing',path:'absent.jsonl'},{...s.config.sources[0],id:'private',conversationAccess:false});writeFileSync(s.path,JSON.stringify(s.config));
 const result=await pipeline.collectDeployment(s.path);assert.equal(result.ok,true);assert.equal(result.report.snapshot.summary.coverage.status,'degraded');assert.equal(result.report.snapshot.summary.perSource.length,3);
});
test('source/config/state/report aliases fail before any state writes including symlinks and hardlinks',async t=>{
 assert.equal(typeof pipeline.collectDeployment,'function');
 for(const target of ['ledger','report','config','symlink','hardlink']){
  const s=setup(t),source=join(s.dir,'events.jsonl');
  if(target==='ledger')s.config.ledger='events.jsonl';
  if(target==='report')s.config.reportDirectory='.';
  if(target==='report')s.config.sources[0].path='report.json';
  if(target==='config')s.config.sources[0].path='deploy.json';
  if(target==='symlink'){symlinkSync(source,join(s.dir,'alias'));s.config.ledger='alias';}
  if(target==='hardlink'){linkSync(source,join(s.dir,'alias'));s.config.ledger='alias';}
  writeFileSync(s.path,JSON.stringify(s.config));const before=readFileSync(source);
  await assert.rejects(pipeline.collectDeployment(s.path),/alias|overlap/i);assert.deepEqual(readFileSync(source),before);assert.equal(existsSync(join(s.dir,'state')),false);
 }
});
function host(mode='full',config={conversationAccess:true,queueCapacity:2}){
 const controller=new AbortController(),hooks={},services=[],disposers=[];
 return {api:{registrationMode:mode,pluginConfig:config,lifecycle:{signal:controller.signal,onDispose(fn){disposers.push(fn);return ()=>{};}},on(name,fn){hooks[name]=fn;},registerService(s){services.push(s);}},hooks,services,controller,disposers};
}
const delivery=()=>({provider:'fixture',model:'model-a',runId:'run',sessionId:'session',usage:{input:2,output:1,cacheRead:0,cacheWrite:0},prompt:'NEVER-PERSIST',assistantTexts:['NEVER-PERSIST'],lastAssistant:{text:'NEVER-PERSIST'}});
test('observer discovery/default denial allocate no state; full mode waits for service start',async t=>{
 assert.equal(typeof observer.registerObserver,'function');const dir=temp(t);
 for(const mode of ['discovery','tool-discovery','cli-metadata','setup-only']){const h=host(mode);observer.registerObserver(h.api);assert.equal(h.services.length,0);h.hooks.llm_output?.(delivery(),{});assert.deepEqual((await import('node:fs')).readdirSync(dir),[]);}
 const deny=host('full',{});observer.registerObserver(deny.api);assert.equal(Object.keys(deny.hooks).length,0);assert.equal(deny.services.length,0);
 const h=host();observer.registerObserver(h.api);h.hooks.llm_output(delivery(),{});assert.equal(h.services.length,1);assert.deepEqual((await import('node:fs')).readdirSync(dir),[]);
});
test('observer projects bounded numeric metadata, marks attempt-only coverage, drops overflow, drains on stop and restarts',async t=>{
 assert.equal(typeof observer.registerObserver,'function');const dir=temp(t),h=host();observer.registerObserver(h.api);const service=h.services[0],ctx={stateDir:dir};await service.start(ctx);
 const event=delivery(),context={agentId:'renamed',accountId:'CHANNEL-NOT-BILLING',sessionKey:'secret-extra',arbitrary:'NEVER-PERSIST'};
 h.hooks.llm_output(event,context);event.usage.input=999;event.model='mutated';h.hooks.llm_output(delivery(),context);h.hooks.llm_output(delivery(),context);
 await service.stop(ctx);
 let ledger=new UsageLedger(join(dir,'token-governor/usage.sqlite'));let summary=ledger.summary();ledger.close();
 assert.equal(summary.perSource[0].eventCount,2);assert.equal(summary.perSource[0].knownTotals.uncachedInput,4);assert.equal(summary.globalComplete,false);assert.equal(summary.groups[0].model,'model-a');assert.match(summary.coverage.reasons.join(' '),/attempt|aggregate/);assert.match(summary.coverage.reasons.join(' '),/overflow/);
 const bytes=readFileSync(join(dir,'token-governor/usage.sqlite')).toString();for(const secret of ['NEVER-PERSIST','CHANNEL-NOT-BILLING','secret-extra'])assert.ok(!bytes.includes(secret));
 h.hooks.llm_output(delivery(),context);await service.start(ctx);h.hooks.llm_output(delivery(),context);await service.stop(ctx);
 ledger=new UsageLedger(join(dir,'token-governor/usage.sqlite'));assert.equal(ledger.summary().perSource[0].eventCount,3);ledger.close();
});
test('observer retirement discards queued generations and never writes after abort; missing lifecycle fails closed',async t=>{
 assert.equal(typeof observer.registerObserver,'function');const dir=temp(t),h=host();observer.registerObserver(h.api);await h.services[0].start({stateDir:dir});h.hooks.llm_output(delivery(),{});h.controller.abort();await h.services[0].stop({stateDir:dir});
 const ledger=new UsageLedger(join(dir,'token-governor/usage.sqlite'));assert.equal(ledger.summary().perSource.length,0);ledger.close();
 const old=host();delete old.api.lifecycle;observer.registerObserver(old.api);assert.equal(old.services.length,0);
});
test('observer rejects malformed metadata individually without losing valid queued records',async t=>{
 const dir=temp(t),h=host();observer.registerObserver(h.api);await h.services[0].start({stateDir:dir});
 h.hooks.llm_output({...delivery(),model:''},{});h.hooks.llm_output(delivery(),{});await h.services[0].stop({stateDir:dir});
 const ledger=new UsageLedger(join(dir,'token-governor/usage.sqlite'));assert.equal(ledger.summary().perSource[0].eventCount,1);assert.match(ledger.summary().coverage.reasons.join(' '),/invalid metadata/);ledger.close();
});
test('observer incomplete lifecycle fails closed',()=>{
 const incomplete=host();incomplete.api.lifecycle.signal={aborted:false};assert.doesNotThrow(()=>observer.registerObserver(incomplete.api));assert.equal(incomplete.services.length,0);
});
test('observer ledger lock leaves host callback bounded and recovers with explicit dropped coverage',async t=>{
 const dir=temp(t),h=host();observer.registerObserver(h.api);await h.services[0].start({stateDir:dir});
 const db=new DatabaseSync(join(dir,'token-governor/usage.sqlite'));db.exec('BEGIN EXCLUSIVE');const start=performance.now();h.hooks.llm_output(delivery(),{});assert.ok(performance.now()-start<100);
 await new Promise(resolve=>setImmediate(resolve));db.exec('ROLLBACK');db.close();h.hooks.llm_output(delivery(),{});await h.services[0].stop({stateDir:dir});
 const ledger=new UsageLedger(join(dir,'token-governor/usage.sqlite'));assert.equal(ledger.summary().perSource[0].eventCount,1);assert.match(ledger.summary().coverage.reasons.join(' '),/write failed/);ledger.close();
});
