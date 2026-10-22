import {mkdirSync,chmodSync,lstatSync,existsSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DIMENSIONS,tokenCount} from './usage.mjs';
const escape=v=>String(v??'unknown').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const vector=o=>Object.fromEntries(DIMENSIONS.map(k=>[k,tokenCount(o?.[k],k)]));
function aggregate(o={}){return {eventCount:tokenCount(o.eventCount,'event count'),totals:vector(o.totals),knownTotals:vector(o.knownTotals),knownCounts:vector(o.knownCounts)};}
function cleanSummary(s) {
 if(!s||typeof s!=='object'||!s.coverage||!Array.isArray(s.coverage.reasons))throw new TypeError('invalid report summary');
 const strings=(o,keys)=>Object.fromEntries(keys.map(k=>[k,typeof o[k]==='string'?o[k]:null]));
 const reasons=x=>x.filter(r=>typeof r==='string').slice(0,100);
 let sourceScope;
 if(s.sourceScope!==undefined){
  const scope=s.sourceScope,ids=values=>{if(!Array.isArray(values)||values.some(v=>typeof v!=='string'||!v.length||v.length>1024||v.includes('\0')))throw new TypeError('invalid source scope');return [...values];};
  if(!scope||!['deployment','all-observations'].includes(scope.kind))throw new TypeError('invalid source scope');
  sourceScope={kind:scope.kind,activeSources:ids(scope.activeSources),inactiveSources:ids(scope.inactiveSources),inactiveRecordCount:tokenCount(scope.inactiveRecordCount)};
 }
 return {schemaVersion:1,...sourceScope?{sourceScope}:{},globalComplete:s.globalComplete===true,global:aggregate(s.global),groups:(s.groups??[]).map(g=>({...strings(g,['source','agentId','sessionId','runId','runtime','provider','model']),...aggregate(g)})),perSource:(s.perSource??[]).map(g=>({source:typeof g.source==='string'?g.source:null,...aggregate(g),quarantinedCount:tokenCount(g.quarantinedCount),reasons:reasons(g.reasons??[])})),coverage:{status:['complete','unknown','degraded'].includes(s.coverage.status)?s.coverage.status:'unknown',reasons:reasons(s.coverage.reasons)},quarantined:tokenCount(s.quarantined),localEstimates:aggregate(s.localEstimates)};
}
function pathsFor(directory){const dir=resolve(directory);return {json:join(dir,'report.json'),html:join(dir,'report.html'),health:join(dir,'collection-health.json')};}
function checkOwned(p,directory=false) {const s=lstatSync(p,{throwIfNoEntry:false});if(s&&(s.isSymbolicLink()||typeof process.getuid==='function'&&s.uid!==process.getuid()||!(directory?s.isDirectory():s.isFile())))throw new Error('report path must be owned and not a symlink');}
function checkPaths(directory,paths){
 checkOwned(resolve(directory),true);const seen=new Set();
 for(const path of Object.values(paths)){checkOwned(path);const s=lstatSync(path,{throwIfNoEntry:false});if(s){const inode=`${s.dev}:${s.ino}`;if(seen.has(inode))throw new Error('report path alias rejected');seen.add(inode);}}
}
function atomicWrite(path,bytes) {const tmp=`${path}.${randomUUID()}.tmp`;try{writeFileSync(tmp,bytes,{flag:'wx',mode:0o600});renameSync(tmp,path);chmodSync(path,0o600);}finally{if(existsSync(tmp))unlinkSync(tmp);}}
/** Render a projected local report. Every data label is escaped; null displays unknown. */
export function renderReportHtml(snapshot) {
 if(!snapshot||!Number.isFinite(snapshot.collectedAt)||!Number.isFinite(snapshot.staleAfterMs)||snapshot.staleAfterMs<0)throw new TypeError('invalid snapshot timestamps');
 const s=cleanSummary(snapshot.summary),freshness='within saved age threshold at publication';
 const rows=s.groups.map(g=>`<tr>${['source','agentId','sessionId','runId','runtime','provider','model'].map(k=>`<td>${escape(g[k])}</td>`).join('')}${DIMENSIONS.map(k=>`<td>${escape(g.totals[k])}</td>`).join('')}</tr>`).join('');
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local token usage</title><style>body{font:16px system-ui;max-width:1200px;margin:40px auto;padding:0 20px;background:#f7f8fa;color:#1a2433}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px;border-bottom:1px solid #ccd2dc;text-align:left}code{overflow-wrap:anywhere}</style><body data-collected-at="${snapshot.collectedAt}" data-stale-after="${snapshot.staleAfterMs}"><h1>Local token usage</h1>${snapshot.provenance?.synthetic===true?'<p><strong>SYNTHETIC offline fixtures · real model requests: 0</strong></p>':''}<p>Saved snapshot age: <strong id="freshness">${escape(freshness)}</strong> · coverage at publication: <strong>${escape(s.coverage.status)}</strong> · complete within saved source scope: ${s.globalComplete}</p><p>This saved HTML does not observe later collection failures. Run CLI report for durable collection health.</p><p>Source scope: ${escape(s.sourceScope?.kind??'unspecified')} · active sources: ${escape(s.sourceScope?.activeSources.join(', ')??'unspecified')} · inactive audit sources excluded: ${escape(s.sourceScope?.inactiveSources.join(', ')??'unspecified')} (${escape(s.sourceScope?.inactiveRecordCount)} records).</p><p>Unknown dimensions are not zero. Local estimates are separate from provider usage.</p><p>Collected at ${escape(new Date(snapshot.collectedAt).toISOString())}</p><ul>${s.coverage.reasons.map(r=>`<li>${escape(r)}</li>`).join('')}</ul><table><thead><tr>${['Source','Agent','Session','Run','Runtime','Provider','Model',...DIMENSIONS].map(k=>`<th>${escape(k)}</th>`).join('')}</tr></thead><tbody>${rows||'<tr><td colspan="11">unknown: no usage groups</td></tr>'}</tbody></table><h2>Provider totals within saved source scope</h2><p>${DIMENSIONS.map(k=>`${escape(k)}: ${escape(s.global.totals[k])}`).join(' · ')}</p><h2>Local estimates (not provider usage)</h2><p>${DIMENSIONS.map(k=>`${escape(k)}: ${escape(s.localEstimates.knownTotals[k])}`).join(' · ')}</p><script>if(Date.now()<Number(document.body.dataset.collectedAt)||Date.now()-Number(document.body.dataset.collectedAt)>Number(document.body.dataset.staleAfter)){document.getElementById('freshness').textContent='over saved age threshold';}</script></body></html>`;
}
/** Read the last successful snapshot and determine current staleness without changing it. */
export function readReport(directory,{now=Date.now(),staleAfterMs}={}) {
 const paths=pathsFor(directory);
 try {
  checkPaths(directory,paths);const snapshot=JSON.parse(readFileSync(paths.json,'utf8'));
  snapshot.summary=cleanSummary(snapshot.summary);
  if(!Number.isFinite(now)||!Number.isFinite(snapshot.collectedAt)||!Number.isFinite(snapshot.staleAfterMs)||snapshot.staleAfterMs<0)throw new Error('invalid snapshot timestamps');
  const threshold=staleAfterMs===undefined?snapshot.staleAfterMs:staleAfterMs;
  if(!Number.isFinite(threshold)||threshold<0)throw new Error('invalid staleness override');
  let collectionHealth={status:'unknown',attemptedAt:null};
  try{
   const h=JSON.parse(readFileSync(paths.health,'utf8'));
   if(h.schemaVersion!==1||!['collecting','failed','healthy'].includes(h.status)||!Number.isFinite(h.attemptedAt)||Object.keys(h).some(k=>!['schemaVersion','status','attemptedAt','publicationId'].includes(k)))throw new Error('invalid health');
   if(h.status==='healthy'&&(typeof h.publicationId!=='string'||!h.publicationId.length||h.publicationId!==snapshot.publicationId))throw new Error('unmatched publication');
   collectionHealth={status:h.status,attemptedAt:h.attemptedAt};
  }catch{}
  const stale=collectionHealth.status!=='healthy'||now<snapshot.collectedAt||now-snapshot.collectedAt>threshold;
  return {status:stale?'stale':snapshot.summary.coverage.status==='degraded'?'degraded':snapshot.summary.coverage.status==='unknown'?'unknown':'fresh',snapshot,paths,collectionHealth};
 }catch{return {status:'unknown',snapshot:null,paths};}
}
/**
 * Collect and publish private local JSON/HTML. Collection/validation failures keep
 * both original files byte-identical and return the stale last successful snapshot.
 * No exception bodies (possibly credentials) enter reports.
 * @param {{directory:string,collect:Function,now?:number,staleAfterMs?:number}} options
 */
export async function writeReport({directory,collect,now=Date.now(),staleAfterMs=15*60*1000,synthetic=false}) {
 if(typeof directory!=='string'||typeof collect!=='function'||!Number.isFinite(now)||!Number.isFinite(staleAfterMs)||staleAfterMs<0)throw new TypeError('invalid report options');
 const paths=pathsFor(directory);checkPaths(directory,paths);
 mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
 const mark=(status,publicationId)=>atomicWrite(paths.health,JSON.stringify({schemaVersion:1,status,attemptedAt:now,...publicationId?{publicationId}:{}})+'\n');
 // Persist non-healthy status before reading sources. A crash or failed final
 // publication cannot inherit the prior snapshot's healthy marker.
 mark('collecting');
 const fallback=()=>{try{mark('failed');}catch{}const old=readReport(directory,{now,staleAfterMs});return {...old,status:old.snapshot?'stale':'unknown',error:'collection failed; last successful snapshot retained'};};
 let snapshot,html,json;
 try {
  snapshot={schemaVersion:1,publicationId:randomUUID(),collectedAt:now,staleAfterMs,provenance:{synthetic:synthetic===true,realModelRequests:synthetic===true?0:null},summary:cleanSummary(await collect())};
  html=renderReportHtml(snapshot);json=JSON.stringify(snapshot,null,2)+'\n';
 }catch{return fallback();}
 checkPaths(directory,paths);
 const snapshots={json:paths.json,html:paths.html};
 const previous=Object.fromEntries(Object.entries(snapshots).map(([k,p])=>[k,existsSync(p)?readFileSync(p):null]));
 try{atomicWrite(paths.json,json);atomicWrite(paths.html,html);mark('healthy',snapshot.publicationId);}
 catch {
  for(const [k,p]of Object.entries(snapshots)){if(previous[k]!==null)atomicWrite(p,previous[k]);else if(existsSync(p))unlinkSync(p);}
  return fallback();
 }
 return readReport(directory,{now,staleAfterMs});
}
