import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const bin=resolve('bin/agent-token-optimizer.mjs');
function run(args,cwd){return spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',bin,...args],{cwd,encoding:'utf8',timeout:20000});}
function temp(t){const dir=mkdtempSync(join(tmpdir(),'ato-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('CLI help and invalid commands have stable bounded output and distinct exit codes',()=>{
 const help=run(['--help']);assert.equal(help.status,0);for(const name of ['init','policy dry-run','collect','report','verify','evaluate'])assert.ok(help.stdout.includes(name));
 const bad=run(['unknown']);assert.equal(bad.status,1);assert.match(bad.stderr,/Usage|invalid/i);
});
test('CLI init is private, refuses overwrite, resolves paths from config, and unknown collection exits 2',t=>{
 const dir=temp(t),target=join(dir,'local');let result=run(['init','--directory',target],dir);assert.equal(result.status,0,result.stderr);
 const config=join(target,'deployment.json');assert.equal(JSON.parse(readFileSync(config)).sources.length,0);assert.equal(run(['init','--directory',target],dir).status,1);
 result=run(['policy','dry-run','--config',config,'--agent-id','renamed'],dir);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).effectiveMode,'observe');
 result=run(['verify','--config',config],dir);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).hostEnforcement,'unverified');
 result=run(['collect','--config',config],dir);assert.equal(result.status,2);assert.equal(JSON.parse(result.stdout).report.status,'unknown');assert.equal(existsSync(join(target,'state')),false);
 assert.equal(run(['report','--config',config],dir).status,2);
});
test('portable demo creates synthetic JSON and escaped HTML with zero actual model requests',t=>{
 const dir=temp(t);const result=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',resolve('scripts/demo.mjs'),'--directory',dir],{encoding:'utf8',timeout:20000});assert.equal(result.status,0,result.stderr);
 const info=JSON.parse(result.stdout),snapshot=JSON.parse(readFileSync(info.json));assert.equal(snapshot.provenance.synthetic,true);assert.equal(snapshot.provenance.realModelRequests,0);
 const html=readFileSync(info.html,'utf8');assert.match(html,/synthetic/i);assert.match(html,/real model requests: 0/i);assert.ok(html.includes('&lt;synthetic-model&gt;'));assert.ok(!html.includes('<synthetic-model>'));
 const config=join(dir,'deployment.json');rmSync(join(dir,'events.jsonl'));const before=readFileSync(info.json);const failed=run(['collect','--config',config],dir);assert.equal(failed.status,2);assert.equal(JSON.parse(failed.stdout).report.status,'stale');assert.deepEqual(readFileSync(info.json),before);
});
test('CLI evaluate never authenticates arbitrary provider JSON as actual evidence',t=>{
 const dir=temp(t),file=join(dir,'invalid.json');writeFileSync(file,'{}');const result=run(['evaluate','--input',file]);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).claimsPermitted,false);
});
