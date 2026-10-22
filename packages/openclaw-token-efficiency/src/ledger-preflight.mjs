import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,readSync,writeSync,fstatSync,lstatSync,mkdtempSync,unlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const LEGACY_SCHEMAS=[
 ['records','CREATE TABLE records(source TEXT NOT NULL, record_key TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL, shared_key TEXT, quarantined INTEGER NOT NULL DEFAULT 0, reason TEXT, PRIMARY KEY(source,record_key))'],
 ['sources','CREATE TABLE sources(source TEXT PRIMARY KEY, cursor TEXT NOT NULL, reasons TEXT NOT NULL)']
];
export const SCOPE_SCHEMA=['collection_scope','CREATE TABLE collection_scope(id INTEGER PRIMARY KEY CHECK(id=1), source_ids TEXT NOT NULL)'];
export const LEDGER_SCHEMAS=[SCOPE_SCHEMA,...LEGACY_SCHEMAS];
const sameVersion=(a,b)=>b&&['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
export function noLedgerSidecars(path){
 if(['-journal','-wal','-shm'].some(suffix=>lstatSync(path+suffix,{throwIfNoEntry:false})))throw new Error('ledger recovery/journal/WAL unsupported; preserve main and sidecars, recover an isolated trusted backup');
}
export function assertLedgerSchema(db,existed){
 const app=db.prepare('PRAGMA application_id').get().application_id;
 const version=db.prepare('PRAGMA user_version').get().user_version;
 const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
 const canonical=sql=>sql.replace(/IF NOT EXISTS /gi,'').replace(/\s+/g,' ').trim();
 const expected=version===2?LEDGER_SCHEMAS:LEGACY_SCHEMAS;
 const exact=tables.length===expected.length&&expected.every(([name,sql],i)=>tables[i].name===name&&canonical(tables[i].sql)===canonical(sql));
 const owned=app===1096044337&&[1,2].includes(version)&&exact,legacy=app===0&&version===0&&exact;
 if(existed&&!owned&&!legacy||!existed&&(app!==0||version!==0||tables.length))throw new Error('ledger ownership/schema unsupported; preserve backup and use separate state');
 return version;
}
export function assertPreflightUnchanged(path,version){
 noLedgerSidecars(path);
 const current=lstatSync(path,{bigint:true,throwIfNoEntry:false});
 if(version?!sameVersion(version,current):current)throw new Error('ledger ownership/schema changed during preflight');
}
/** SQLite never opens the original path during ownership preflight. Like the
 * source adapter, open an empty private inode read-only and unlink its name
 * BEFORE copying bytes. Streaming two matching reads bounds memory to 64KiB. */
export function preflightLedger(path){
 noLedgerSidecars(path);
 if(!lstatSync(path,{throwIfNoEntry:false}))return null;
 let source,copy,db,directory;
 try{
  source=openSync(path,'r');const before=fstatSync(source,{bigint:true});
  if(!before.isFile()||before.size<100n||before.size>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('ledger ownership/schema unsupported');
  const header=Buffer.alloc(100);let offset=0;
  while(offset<header.length){const n=readSync(source,header,offset,header.length-offset,offset);if(!n)throw new Error('ledger ownership/schema unavailable');offset+=n;}
  if(header.subarray(0,16).toString('binary')!=='SQLite format 3\0')throw new Error('ledger ownership/schema unsupported');
  if(header[18]!==1||header[19]!==1)throw new Error('ledger WAL/recovery unsupported; preserve backup and use checkpointed rollback-journal state');
  const app=header.readUInt32BE(68),version=header.readUInt32BE(60);
  if(!(app===1096044337&&[1,2].includes(version)||app===0&&version===0))throw new Error('ledger ownership/schema unsupported');
  directory=mkdtempSync(join(tmpdir(),'ato-ledger-preflight-'));
  const temporary=join(directory,'empty.sqlite');copy=openSync(temporary,'wx+',0o600);
  db=new DatabaseSync(temporary,{readOnly:true});unlinkSync(temporary);
  if(fstatSync(copy).nlink!==0)throw new Error('ledger ownership preflight requires anonymous SQLite support');
  const buffer=Buffer.alloc(64*1024),size=Number(before.size);
  function scan(copyBytes){
   const hash=createHash('sha256');let position=0;
   while(position<size){
    const n=readSync(source,buffer,0,Math.min(buffer.length,size-position),position);if(!n)throw new Error('ledger changed during preflight');
    hash.update(buffer.subarray(0,n));
    if(copyBytes){let written=0;while(written<n){const count=writeSync(copy,buffer,written,n-written,position+written);if(count<=0)throw new Error('ledger preflight copy failed');written+=count;}}
    position+=n;
   }
   return hash.digest('hex');
  }
  if(scan(true)!==scan(false)||!sameVersion(before,fstatSync(source,{bigint:true})))throw new Error('ledger changed during preflight');
  assertPreflightUnchanged(path,before);
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');assertLedgerSchema(db,true);
  assertPreflightUnchanged(path,before);return before;
 }finally{
  try{db?.close();}finally{try{if(copy!==undefined)closeSync(copy);}finally{try{if(source!==undefined)closeSync(source);}finally{if(directory)rmSync(directory,{recursive:true,force:true});}}}
 }
}
