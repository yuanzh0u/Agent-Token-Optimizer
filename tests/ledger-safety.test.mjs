import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,linkSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {UsageLedger} from '../packages/openclaw-token-efficiency/src/ledger.mjs';
import {collectDeployment} from '../src/collector.mjs';

function temporary(t){const dir=mkdtempSync(join(tmpdir(),'ato-ledger-safety-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function files(directory){
 return Object.fromEntries(readdirSync(directory,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()||e.isSymbolicLink()).map(e=>{const path=join(e.parentPath,e.name);return [path,readFileSync(path)];}));
}
test('all ledger sidecars are reserved against config/policy/report/source aliases before writes',async t=>{
 for(const suffix of ['-journal','-wal','-shm'])for(const target of ['config','policy','report.json','report.html','source'])for(const kind of ['direct','hardlink','symlink']){
  // Report names are fixed, so their alias to a sidecar requires a link.
  if(kind==='direct'&&target.startsWith('report.'))continue;
  const dir=temporary(t),ledger=join(dir,'usage.sqlite'),sidecar=ledger+suffix;
  const state=new UsageLedger(ledger);state.close();mkdirSync(join(dir,'report'));
  const mapping={fields:{input:'input',output:'output'},inputIncludesCacheRead:false,inputIncludesCacheWrite:false,metadata:{sourceRecordKey:'id'}};
  const config={version:1,policy:'policy.json',ledger:'usage.sqlite',reportDirectory:'report',sources:[{id:'fixture',type:'jsonl',path:'source.jsonl',conversationAccess:true,mapping}]};
  let configPath=join(dir,'deployment.json'),protectedPath;
  if(target==='config'){protectedPath=configPath;if(kind==='direct')configPath=sidecar;}
  if(target==='policy'){protectedPath=join(dir,'policy.json');if(kind==='direct')config.policy=sidecar;}
  if(target==='source'){protectedPath=join(dir,'source.jsonl');if(kind==='direct')config.sources[0].path=sidecar;}
  if(target.startsWith('report.'))protectedPath=join(dir,'report',target);
  writeFileSync(join(dir,'source.jsonl'),JSON.stringify({id:'one',input:3,output:1})+'\n');
  writeFileSync(configPath,JSON.stringify(config));
  const bytes=target==='config'?JSON.stringify(config):target==='source'?JSON.stringify({id:'one',input:3,output:1})+'\n':'{"version":1,"profiles":{},"bindings":[]}';
  writeFileSync(sidecar,bytes);
  if(kind!=='direct'){
   rmSync(protectedPath,{force:true});
   if(kind==='hardlink')linkSync(sidecar,protectedPath);else symlinkSync(sidecar,protectedPath);
  }
  const before=files(dir);let rejected;
  try{await collectDeployment(configPath);}catch(error){rejected=error;}
  assert.deepEqual(files(dir),before,`${target}/${suffix}/${kind}: protected bytes or sidecars changed`);
  assert.match(rejected?.message??'',/alias|overlap/,`${target}/${suffix}/${kind}: must reject before opening state`);
 }
});
test('hot foreign rollback journal rejects without recovery or main/sidecar mutation',t=>{
 const dir=temporary(t),path=join(dir,'foreign.sqlite');
 const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./helpers/hot-ledger-fixture.mjs',import.meta.url)),path],{stdio:'ignore',timeout:10000});
 assert.equal(child.error,undefined);assert.equal(child.signal,'SIGKILL');
 const main=readFileSync(path),journal=readFileSync(path+'-journal');
 assert.ok(journal.length>512);assert.deepEqual(journal.subarray(0,8),Buffer.from('d9d505f920a163d7','hex'));
 assert.throws(()=>new UsageLedger(path),/ownership|schema|recovery|journal|unsupported/);
 assert.deepEqual({main:main.equals(readFileSync(path)),journal:existsSync(path+'-journal')&&journal.equals(readFileSync(path+'-journal'))},{main:true,journal:true});
});
test('WAL-mode foreign state and cold sidecars reject without SQLite coordination writes',t=>{
 for(const variant of ['wal-header','-wal','-shm','-journal','missing-main']){
  const dir=temporary(t),path=join(dir,'foreign.sqlite');
  if(variant!=='missing-main'){
   const db=new DatabaseSync(path);db.exec(`${variant==='wal-header'?'PRAGMA journal_mode=WAL;':''} CREATE TABLE foreign_data(secret TEXT)`);db.close();
  }
  if(variant!=='wal-header')writeFileSync(path+(variant==='missing-main'?'-journal':variant),'COLD-SIDECAR-MUST-SURVIVE');
  const before=files(dir);assert.throws(()=>new UsageLedger(path),/ownership|schema|recovery|journal|unsupported|WAL/);assert.deepEqual(files(dir),before,variant);
 }
});
