import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const report=await import('../packages/openclaw-token-efficiency/src/report.mjs').catch(()=>({}));
const summary={schemaVersion:1,globalComplete:false,global:{eventCount:0,totals:{uncachedInput:null,output:null,cacheRead:null,cacheWrite:null}},perSource:[],groups:[{source:'synthetic',agentId:'<img src=x onerror=alert(1)>',sessionId:'s',runId:'r',runtime:'node',provider:'p',eventCount:1,totals:{uncachedInput:140,output:null,cacheRead:900,cacheWrite:20}}],coverage:{status:'degraded',reasons:['missing usage']},localEstimates:{knownTotals:{output:42}},prompt:'PRIVATE-BODY',credentials:{apiKey:'PRIVATE-KEY'}};
function dir(t){const d=mkdtempSync(join(tmpdir(),'ato-report-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return join(d,'reports');}
test('local JSON and HTML expose unknown/degraded coverage, escape labels, and omit bodies/credentials',async t=>{
 assert.equal(typeof report.writeReport,'function');const directory=dir(t);
 const result=await report.writeReport({directory,collect:()=>summary,now:1000,staleAfterMs:100});
 const html=readFileSync(result.paths.html,'utf8'),json=readFileSync(result.paths.json,'utf8');
 assert.match(html,/&lt;img/);assert.ok(!html.includes('<img'));assert.match(html,/unknown/);assert.match(html,/degraded/);
 assert.ok(!json.includes('PRIVATE'));assert.ok(!html.includes('PRIVATE'));assert.equal(statSync(directory).mode&0o777,0o700);
 assert.equal(statSync(result.paths.json).mode&0o777,0o600);assert.equal(statSync(result.paths.html).mode&0o777,0o600);
 const stale=report.readReport(directory,{now:1200,staleAfterMs:100});assert.equal(stale.status,'stale');assert.equal(stale.snapshot.collectedAt,1000);
});
test('failed collection retains byte-identical successful reports and returns stale snapshot',async t=>{
 assert.equal(typeof report.writeReport,'function');const directory=dir(t);
 const first=await report.writeReport({directory,collect:()=>summary,now:1000});
 const json=readFileSync(first.paths.json),html=readFileSync(first.paths.html);
 const failed=await report.writeReport({directory,collect:()=>{throw Error('credential=PRIVATE-KEY');},now:2000});
 assert.equal(failed.status,'stale');assert.equal(failed.snapshot.collectedAt,1000);assert.ok(!JSON.stringify(failed).includes('PRIVATE-KEY'));
 assert.deepEqual(readFileSync(first.paths.json),json);assert.deepEqual(readFileSync(first.paths.html),html);
});
test('failed initial collection reports unknown, never fabricated zero counts',async t=>{
 assert.equal(typeof report.writeReport,'function');const r=await report.writeReport({directory:dir(t),collect:()=>{throw Error('bad');},now:100});
 assert.equal(r.status,'unknown');assert.equal(r.snapshot,null);
});
test('unknown coverage remains unknown on reread',async t=>{
 const directory=dir(t);await report.writeReport({directory,collect:()=>({...summary,coverage:{status:'unknown',reasons:['missing source']}}),now:1000});
 assert.equal(report.readReport(directory,{now:1001}).status,'unknown');
});
test('renderer validates timestamp attributes',()=>{
 assert.throws(()=>report.renderReportHtml({collectedAt:1000,staleAfterMs:'0" onload="alert(1)',summary}),/timestamp|snapshot/);
});

test('reread uses the saved staleness threshold unless intentionally overridden',async t=>{
 const directory=dir(t);await report.writeReport({directory,collect:()=>({...summary,globalComplete:true,coverage:{status:'complete',reasons:[]}}),now:1000,staleAfterMs:100});
 assert.equal(report.readReport(directory,{now:1200}).status,'stale');
 assert.equal(report.readReport(directory,{now:1200,staleAfterMs:500}).status,'fresh');
});
test('reread rejects an invalid persisted staleness threshold',async t=>{
 const directory=dir(t),saved=await report.writeReport({directory,collect:()=>summary,now:1000,staleAfterMs:100});
 for(const threshold of [-1,'100',null]){
  writeFileSync(saved.paths.json,JSON.stringify({...saved.snapshot,staleAfterMs:threshold}));
  const result=report.readReport(directory,{now:1001});assert.equal(result.status,'unknown');assert.equal(result.snapshot,null);
 }
});
