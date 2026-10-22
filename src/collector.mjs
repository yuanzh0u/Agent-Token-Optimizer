import {readFileSync,existsSync,realpathSync,statSync,lstatSync} from 'node:fs';
import {dirname,resolve,join,basename} from 'node:path';
import {collectSource,discoverSources,UsageLedger,writeReport} from '../packages/openclaw-token-efficiency/src/index.mjs';

// Resolve even a missing leaf through its nearest existing parent. Also compare
// inodes so hard links cannot disguise a source as an output destination.
function physical(path){
 let parent=resolve(path),tail=[];
 if(lstatSync(parent,{throwIfNoEntry:false})?.isSymbolicLink()&&!existsSync(parent))throw new Error('dangling path alias rejected');
 while(!existsSync(parent)){tail.unshift(basename(parent));const next=dirname(parent);if(next===parent)break;parent=next;}
 return join(realpathSync(parent),...tail);
}
function aliases(a,b){
 if(physical(a)===physical(b))return true;
 if(!existsSync(a)||!existsSync(b))return false;
 const x=statSync(a),y=statSync(b);return x.dev===y.dev&&x.ino===y.ino;
}
/** Explicit deployment paths only; validation completes before opening state. */
export function loadDeployment(path){
 const absolute=resolve(path),base=dirname(absolute),raw=JSON.parse(readFileSync(absolute,'utf8'));
 const allowed=['version','policy','ledger','reportDirectory','sources','staleAfterMs'];
 if(!raw||raw.version!==1||Object.keys(raw).some(k=>!allowed.includes(k))||!Array.isArray(raw.sources))throw new TypeError('invalid deployment v1');
 for(const k of ['policy','ledger','reportDirectory'])if(typeof raw[k]!=='string'||!raw[k].length)throw new TypeError(`deployment ${k} path required`);
 if(raw.staleAfterMs!==undefined&&(!Number.isSafeInteger(raw.staleAfterMs)||raw.staleAfterMs<0))throw new TypeError('invalid staleness threshold');
 const config={...raw,configPath:absolute,policy:resolve(base,raw.policy),ledger:resolve(base,raw.ledger),reportDirectory:resolve(base,raw.reportDirectory),sources:raw.sources.map(s=>({...s,path:typeof s.path==='string'?resolve(base,s.path):s.path}))};
 const protectedPaths=[absolute,config.policy,config.ledger,join(config.reportDirectory,'report.json'),join(config.reportDirectory,'report.html'),join(config.reportDirectory,'collection-health.json'),...['-wal','-shm','-journal'].map(suffix=>config.ledger+suffix)];
 for(let i=0;i<protectedPaths.length;i++)for(let j=i+1;j<protectedPaths.length;j++)if(aliases(protectedPaths[i],protectedPaths[j]))throw new Error('config/state/report path alias rejected');
 for(const s of config.sources)if(typeof s.path==='string')for(const p of protectedPaths)if(aliases(s.path,p))throw new Error('source/config/state/report path alias rejected');
 const ids=new Set();for(const s of config.sources){if(typeof s.id!=='string'||!s.id.length||ids.has(s.id))throw new TypeError('source IDs must be unique nonempty strings');ids.add(s.id);}
 return config;
}
/** Collect full scans, but reconcile only complete scans. Never open source SQLite. */
export async function collectDeployment(path){
 const config=loadDeployment(path),sources=[];
 let ledger,failureCode=null;
 try {
  const report=await writeReport({directory:config.reportDirectory,staleAfterMs:config.staleAfterMs,collect:()=>{
   const results=discoverSources(config).sources.map(collectSource);
   sources.push(...results.map(({source,status,reasons,excluded})=>({source,status,reasons,excluded})));
   // Empty/failed/excluded-only scans cannot publish a healthy zero or replace
   // the last good report. A degraded scan with actual records remains partial.
   if(!results.some(s=>s.status==='complete'||s.status==='degraded'&&s.events.length)){failureCode='no-usable-sources';throw new Error('all sources failed');}
   try{ledger=new UsageLedger(config.ledger);}catch{failureCode='state-unavailable-or-unsupported-schema';throw new Error('state unavailable');}
   failureCode='ledger-write-failed';
   ledger.setSourceScope(config.sources.map(s=>s.id));
   for(const s of results)ledger.ingest(s.events,{source:s.source,cursor:s.cursor,reconcile:s.status==='complete',reasons:s.status==='complete'?s.reasons:[...s.reasons,`source coverage: ${s.status}`]});
   const summary=ledger.summary();failureCode=null;return summary;
  }});
  return {ok:!report.error,failureCode,sources,report};
 }finally{ledger?.close();}
}
