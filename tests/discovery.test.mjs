import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,chmodSync,rmSync,readdirSync,mkdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as zlib from 'node:zlib';
const adapter=await import('../packages/openclaw-token-efficiency/src/discovery.mjs').catch(()=>({}));
const {UsageLedger}=await import('../packages/openclaw-token-efficiency/src/ledger.mjs');
const mapping={fields:{input:'usage.input',output:'usage.output',cacheRead:'usage.cacheRead',cacheWrite:'usage.cacheWrite'},inputIncludesCacheRead:false,inputIncludesCacheWrite:false,metadata:{sourceRecordKey:'id',agentId:'agentId',sessionId:'sessionId',runId:'runId',provider:'provider',accountId:'accountId',requestId:'requestId',runtime:'runtime'}};
const record=(id,extra={})=>({id,usage:{input:140,output:15,cacheRead:900,cacheWrite:20},agentId:'a',sessionId:'s',runId:'r',provider:'p',accountId:'account',requestId:id,runtime:'node',prompt:'RAW-CONTENT-SECRET',...extra});
function dir(t){const d=mkdtempSync(join(tmpdir(),'ato-source-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}
test('discovery uses only explicit sources and excludes private/unapproved formats',()=>{
 assert.equal(typeof adapter.discoverSources,'function');
 assert.equal(adapter.discoverSources({}).sources.length,0);
 const r=adapter.discoverSources({sources:[{id:'private',type:'jsonl',path:'/irrelevant',conversationAccess:false,mapping},{id:'incognito',type:'jsonl',path:'/irrelevant',conversationAccess:true,incognito:true,mapping},{id:'unknown',type:'magic',path:'/irrelevant',conversationAccess:true,mapping}]});
 assert.deepEqual(r.sources.map(s=>s.status),['excluded','excluded','unsupported']);
 assert.match(r.coverage.reasons.join(' '),/unsupported/);
});
test('JSONL full scan projects usage only and prevents incognito/transcript backfill',t=>{
 assert.equal(typeof adapter.collectSource,'function');const d=dir(t),path=join(d,'events.jsonl');
 writeFileSync(path,[record('1'),record('2',{incognito:true}),record('3',{conversationAccess:false}),record('4',{agentId:undefined})].map(JSON.stringify).join('\n'));
 const source={id:'file',type:'jsonl',path,conversationAccess:true,mapping};
 const r=adapter.collectSource(source);assert.equal(r.events.length,2);assert.equal(r.excluded,2);assert.equal(r.fullRescan,true);
 assert.ok(!JSON.stringify(r).includes('RAW-CONTENT-SECRET'));assert.equal(r.events[1].agentId,undefined);
 const before=readFileSync(path);adapter.collectSource(source);assert.deepEqual(readFileSync(path),before);
});
test('corrupt and permission-denied JSONL reports degraded instead of zero success',t=>{
 assert.equal(typeof adapter.collectSource,'function');const d=dir(t),path=join(d,'events.jsonl');
 writeFileSync(path,`${JSON.stringify(record('1'))}\n{bad raw secret`);
 const source={id:'file',type:'jsonl',path,conversationAccess:true,mapping};
 const corrupt=adapter.collectSource(source);assert.equal(corrupt.status,'degraded');assert.equal(corrupt.events.length,1);
 assert.ok(!JSON.stringify(corrupt).includes('bad raw secret'));
 chmodSync(path,0);const denied=adapter.collectSource(source);assert.equal(denied.status,'degraded');assert.match(denied.reasons.join(' '),/permission/);chmodSync(path,0o600);
});
test('configured SQLite introspects schema read-only and detects changed old sequence',t=>{
 assert.equal(typeof adapter.collectSource,'function');const d=dir(t),path=join(d,'host.sqlite');const host=new DatabaseSync(path);t.after(()=>host.close());
 host.exec('CREATE TABLE events(session TEXT, seq INTEGER, payload TEXT)');
 host.prepare('INSERT INTO events VALUES(?,?,?)').run('s',1,JSON.stringify(record('one')));
 const source={id:'db',type:'sqlite',path,conversationAccess:true,table:'events',columns:{json:'payload',keys:['session','seq']},mapping};
 const before=sourceFiles(d);const first=adapter.collectSource(source);assert.equal(first.events.length,1);assert.deepEqual(sourceFiles(d),before);
 const ledger=new UsageLedger(join(d,'own','ledger.sqlite'));t.after(()=>ledger.close());
 ledger.ingest(first.events,{source:'db',cursor:first.cursor,reconcile:true,reasons:first.reasons});
 host.prepare('UPDATE events SET payload=? WHERE seq=1').run(JSON.stringify(record('one',{usage:{input:140,output:17,cacheRead:900,cacheWrite:20}})));
 const next=adapter.collectSource(source);ledger.ingest(next.events,{source:'db',cursor:next.cursor,reconcile:true,reasons:next.reasons});
 assert.equal(ledger.summary().quarantined,1);
 const unsupported=adapter.collectSource({...source,columns:{json:'missing',keys:['seq']}});assert.equal(unsupported.status,'unsupported');assert.equal(unsupported.events.length,0);
});
test('SQLite zstd is decoded where supported and corruption degrades without content', {skip:typeof zlib.zstdCompressSync!=='function'},t=>{
 assert.equal(typeof adapter.collectSource,'function');const d=dir(t),path=join(d,'zstd.sqlite'),db=new DatabaseSync(path);t.after(()=>db.close());
 db.exec('CREATE TABLE events(seq INTEGER, compressed BLOB)');
 db.prepare('INSERT INTO events VALUES(?,?)').run(1,zlib.zstdCompressSync(JSON.stringify(record('one'))));
 db.prepare('INSERT INTO events VALUES(?,?)').run(2,Buffer.from('corrupt RAW-CONTENT-SECRET'));
 const result=adapter.collectSource({id:'db',type:'sqlite',path,conversationAccess:true,table:'events',columns:{zstd:'compressed',keys:['seq']},mapping});
 assert.equal(result.events.length,1);assert.equal(result.status,'degraded');assert.match(result.reasons.join(' '),/decode/);assert.ok(!JSON.stringify(result).includes('RAW-CONTENT-SECRET'));
});

function sourceFiles(directory){return Object.fromEntries(readdirSync(directory).sort().map(name=>[name,readFileSync(join(directory,name))]));}
test('closed WAL-mode SQLite never creates source-side WAL/SHM files',t=>{
 const directory=dir(t),path=join(directory,'source.sqlite');
 const host=new DatabaseSync(path);host.exec('PRAGMA journal_mode=WAL; CREATE TABLE events(seq INTEGER,payload TEXT)');
 host.prepare('INSERT INTO events VALUES(?,?)').run(1,JSON.stringify(record('one')));host.close();
 const before=sourceFiles(directory);assert.deepEqual(Object.keys(before),['source.sqlite']);
 const result=adapter.collectSource({id:'wal',type:'sqlite',path,conversationAccess:true,table:'events',columns:{json:'payload',keys:['seq']},mapping});
 assert.deepEqual(sourceFiles(directory),before,'collection must not create or modify any source file');
 assert.equal(result.status,'unsupported');assert.equal(result.events.length,0);
 assert.match(result.reasons.join(' '),/consistent checkpointed rollback-journal snapshot/);
});
test('live committed WAL usage is explicitly unsupported without reading stale main-only data',t=>{
 const directory=dir(t),path=join(directory,'source.sqlite'),host=new DatabaseSync(path);t.after(()=>host.close());
 host.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events(seq INTEGER,payload TEXT); PRAGMA wal_checkpoint(TRUNCATE)');
 host.prepare('INSERT INTO events VALUES(?,?)').run(1,JSON.stringify(record('live-wal')));
 const before=sourceFiles(directory);assert.ok(before['source.sqlite-wal'].length>0);
 const result=adapter.collectSource({id:'wal',type:'sqlite',path,conversationAccess:true,table:'events',columns:{json:'payload',keys:['seq']},mapping});
 assert.equal(result.status,'unsupported');assert.equal(result.events.length,0);assert.equal(result.cursor,null);
 assert.deepEqual(sourceFiles(directory),before,'collection must not modify live WAL sidecars');
 assert.match(result.reasons.join(' '),/WAL/);
});
test('mixed valid and corrupt JSONL keeps only labeled partial totals at source and group scopes',t=>{
 const directory=dir(t),path=join(directory,'source.jsonl');writeFileSync(path,JSON.stringify(record('valid'))+'\n{corrupt');
 const collected=adapter.collectSource({id:'mixed',type:'jsonl',path,conversationAccess:true,mapping});
 assert.equal(collected.status,'degraded');assert.equal(collected.events.length,1);
 const ledger=new UsageLedger(join(directory,'private','usage.sqlite'));t.after(()=>ledger.close());
 const summary=ledger.ingest(collected.events,{source:collected.source,cursor:collected.cursor,reasons:collected.reasons,reconcile:true});
 const unknown={uncachedInput:null,output:null,cacheRead:null,cacheWrite:null};
 assert.deepEqual(summary.perSource[0].totals,unknown);assert.deepEqual(summary.groups[0].totals,unknown);
 assert.deepEqual(summary.perSource[0].knownTotals,{uncachedInput:140,output:15,cacheRead:900,cacheWrite:20});
 assert.deepEqual(summary.groups[0].knownCounts,{uncachedInput:1,output:1,cacheRead:1,cacheWrite:1});
 ledger.ingest([{sourceRecordKey:'healthy',provider:'p',accountId:'a',requestId:'healthy',agentId:'a',sessionId:'s',runId:'r',runtime:'node',uncachedInput:10,output:1,cacheRead:0,cacheWrite:0}],{source:'healthy'});
 assert.deepEqual(ledger.summary().groups.find(g=>g.source==='healthy').totals,{uncachedInput:10,output:1,cacheRead:0,cacheWrite:0});
});

test('SQLite private copies are cleaned after success, unsupported schema, and decode/open failures',t=>{
 const directory=dir(t),path=join(directory,'source.sqlite'),host=new DatabaseSync(path);
 host.exec('CREATE TABLE events(seq INTEGER,payload TEXT)');host.prepare('INSERT INTO events VALUES(?,?)').run(1,JSON.stringify(record('one')));host.close();
 const source={id:'rollback',type:'sqlite',path,conversationAccess:true,table:'events',columns:{json:'payload',keys:['seq']},mapping};
 const copies=()=>readdirSync(tmpdir()).filter(name=>name.startsWith('ato-sqlite-copy-')).sort();
 const before=copies(),sourceBefore=sourceFiles(directory);
 assert.equal(adapter.collectSource(source).status,'complete');
 assert.equal(adapter.collectSource({...source,columns:{json:'missing',keys:['seq']}}).status,'unsupported');
 assert.equal(adapter.collectSource({...source,maxBytes:8}).status,'degraded');
 assert.deepEqual(copies(),before);assert.deepEqual(sourceFiles(directory),sourceBefore);
 const editor=new DatabaseSync(path);editor.prepare('UPDATE events SET payload=?').run('{corrupt JSON');editor.close();
 const badPayload=sourceFiles(directory);assert.equal(adapter.collectSource(source).status,'degraded');assert.deepEqual(copies(),before);assert.deepEqual(sourceFiles(directory),badPayload);
 writeFileSync(path,'not a SQLite database');const corrupt=sourceFiles(directory);
 assert.equal(adapter.collectSource(source).status,'degraded');assert.deepEqual(copies(),before);assert.deepEqual(sourceFiles(directory),corrupt);
});
test('SQLite active rollback journal is explicitly unsupported and left byte-identical',t=>{
 const directory=dir(t),path=join(directory,'source.sqlite'),host=new DatabaseSync(path);
 host.exec('CREATE TABLE events(seq INTEGER,payload TEXT)');host.close();
 writeFileSync(path+'-journal','synthetic active rollback journal');const before=sourceFiles(directory);
 const result=adapter.collectSource({id:'journal',type:'sqlite',path,conversationAccess:true,table:'events',columns:{json:'payload',keys:['seq']},mapping});
 assert.equal(result.status,'unsupported');assert.equal(result.events.length,0);assert.deepEqual(sourceFiles(directory),before);
});

function runProbe(sourcePath,tempDirectory,mode) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./helpers/sqlite-collection-probe.mjs',import.meta.url)),sourcePath],{env:{...process.env,TMPDIR:tempDirectory,ATO_PROBE_MODE:mode},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',ready=false;
  const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('collection probe timed out'));},10000);
  child.stdout.on('data',data=>{stdout+=data.toString();if(mode==='kill'&&!ready&&stdout.includes('QUERY_READY')){ready=true;child.kill('SIGKILL');}});
  child.stderr.on('data',data=>{stderr+=data.toString();});
  child.once('error',error=>{clearTimeout(timeout);reject(error);});
  child.once('close',(code,signal)=>{clearTimeout(timeout);resolve({stdout,stderr,code,signal,ready});});
 });
}
function namedFiles(directory) {
 return readdirSync(directory).flatMap(name=>{const path=join(directory,name);return statSync(path).isDirectory()?namedFiles(path):[path];});
}
function assertNoNamedBodies(directory) {
 for(const path of namedFiles(directory)) {
  const contents=readFileSync(path);
  for(const secret of ['SYNTHETIC-INCOGNITO-PRIVATE-BODY','SYNTHETIC-PUBLIC-PROMPT-BODY'])assert.ok(!contents.includes(Buffer.from(secret)),`named raw body remains at ${path}`);
 }
}
function probeFixture(t,busy=false) {
 const directory=dir(t),sourceDirectory=join(directory,'source'),tempDirectory=join(directory,'temporary');mkdirSync(sourceDirectory);mkdirSync(tempDirectory);
 const path=join(sourceDirectory,'source.sqlite'),host=new DatabaseSync(path);
 host.exec('CREATE TABLE raw_events(seq INTEGER,payload TEXT)');
 host.prepare('INSERT INTO raw_events VALUES(?,?)').run(1,JSON.stringify(record('public',{prompt:'SYNTHETIC-PUBLIC-PROMPT-BODY'})));
 host.prepare('INSERT INTO raw_events VALUES(?,?)').run(2,JSON.stringify(record('private',{incognito:true,prompt:'SYNTHETIC-INCOGNITO-PRIVATE-BODY'})));
 if(busy)host.exec('CREATE VIEW events AS WITH RECURSIVE delay(value) AS (VALUES(0) UNION ALL SELECT value+1 FROM delay WHERE value<100000000) SELECT raw_events.seq,raw_events.payload FROM raw_events JOIN delay ON delay.value=100000000');
 else host.exec('CREATE VIEW events AS SELECT * FROM raw_events');
 host.close();
 const source={id:'probe',type:'sqlite',path,conversationAccess:true,table:'events',columns:{json:'payload',keys:['seq']},mapping};
 const sourcePath=join(directory,'descriptor.json');writeFileSync(sourcePath,JSON.stringify(source));
 return {sourceDirectory,tempDirectory,sourcePath};
}
test('SIGKILL during SQLite collection retains no named raw or incognito bodies and never mutates source',async t=>{
 const {sourceDirectory,tempDirectory,sourcePath}=probeFixture(t,true),before=sourceFiles(sourceDirectory);
 const result=await runProbe(sourcePath,tempDirectory,'kill');
 assert.equal(result.ready,true,result.stderr);assert.equal(result.signal,'SIGKILL');
 assert.deepEqual(sourceFiles(sourceDirectory),before);assertNoNamedBodies(tempDirectory);
});
test('platforms that cannot unlink an open SQLite file reject before writing any raw bytes',async t=>{
 const {sourceDirectory,tempDirectory,sourcePath}=probeFixture(t),before=sourceFiles(sourceDirectory);
 const result=await runProbe(sourcePath,tempDirectory,'unlink-denied');
 assert.equal(result.code,0,result.stderr);const collection=JSON.parse(result.stdout);
 assert.equal(collection.status,'unsupported');assert.equal(collection.events.length,0);assert.equal(collection.cursor,null);
 assert.match(collection.reasons.join(' '),/anonymous|unlink/);
 assert.deepEqual(sourceFiles(sourceDirectory),before);assertNoNamedBodies(tempDirectory);
});

test('SQLite rejects a still-linked snapshot inode before copying raw bytes',async t=>{
 const {sourceDirectory,tempDirectory,sourcePath}=probeFixture(t),before=sourceFiles(sourceDirectory);
 const result=await runProbe(sourcePath,tempDirectory,'unlink-noop');
 assert.equal(result.code,0,result.stderr);const collection=JSON.parse(result.stdout);
 assert.equal(collection.status,'unsupported');assert.equal(collection.events.length,0);
 assert.deepEqual(sourceFiles(sourceDirectory),before);assertNoNamedBodies(tempDirectory);
});
test('short anonymous-file writes are completed and incognito records remain excluded',async t=>{
 const {sourceDirectory,tempDirectory,sourcePath}=probeFixture(t),before=sourceFiles(sourceDirectory);
 const result=await runProbe(sourcePath,tempDirectory,'partial-write');
 assert.equal(result.code,0,result.stderr);const collection=JSON.parse(result.stdout);
 assert.equal(collection.status,'complete');assert.equal(collection.excluded,1);assert.equal(collection.events.length,1);
 assert.deepEqual([collection.events[0].uncachedInput,collection.events[0].output,collection.events[0].cacheRead,collection.events[0].cacheWrite],[140,15,900,20]);
 assert.ok(!result.stdout.includes('SYNTHETIC-'));assert.deepEqual(sourceFiles(sourceDirectory),before);assertNoNamedBodies(tempDirectory);
});
test('zero-progress anonymous-file writes degrade without hanging or retaining raw bytes',async t=>{
 const {sourceDirectory,tempDirectory,sourcePath}=probeFixture(t),before=sourceFiles(sourceDirectory);
 const result=await runProbe(sourcePath,tempDirectory,'zero-write');
 assert.equal(result.code,0,result.stderr);const collection=JSON.parse(result.stdout);
 assert.equal(collection.status,'degraded');assert.equal(collection.events.length,0);
 assert.deepEqual(sourceFiles(sourceDirectory),before);assertNoNamedBodies(tempDirectory);
});
