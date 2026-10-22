// Isolated filesystem-fault and crash probe; no production test hooks.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const mode=process.env.ATO_PROBE_MODE;
const originalWrite=fs.writeSync;
if(mode==='unlink-noop')fs.unlinkSync=()=>{};
if(mode==='zero-write')fs.writeSync=(fd,buffer,...args)=>Buffer.isBuffer(buffer)?0:originalWrite(fd,buffer,...args);
if(mode==='unlink-denied')fs.unlinkSync=()=>{throw Object.assign(new Error('synthetic unlink denial'),{code:'EPERM'});};
if(mode==='partial-write')fs.writeSync=(fd,buffer,offset,length,position)=>Buffer.isBuffer(buffer)&&Number.isInteger(length)?originalWrite(fd,buffer,offset,Math.min(length,17),position):originalWrite(fd,buffer,offset,length,position);
syncBuiltinESMExports();
if(mode==='kill') {
 const originalPrepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){
  if(sql.startsWith('SELECT ')&&sql.includes('FROM "events"'))originalWrite(1,'QUERY_READY\n');
  return Reflect.apply(originalPrepare,this,[sql]);
 };
}
const {collectSource}=await import('../../packages/openclaw-token-efficiency/src/discovery.mjs');
const source=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const result=collectSource(source);
originalWrite(1,JSON.stringify(result)+'\n');
