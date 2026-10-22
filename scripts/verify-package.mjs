import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,writeSync,openSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
/** Packs the actual distributable. All execution below occurs in a fresh tree. */
export async function verifyPackage({keepDirectory=false}={}){
 const temporary=mkdtempSync(join(tmpdir(),'ato-package-proof-'));
 const env={PATH:process.env.PATH,HOME:temporary,npm_config_cache:join(temporary,'npm-cache'),npm_config_offline:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_userconfig:join(temporary,'empty-npmrc'),NODE_NO_WARNINGS:'1'};
 writeFileSync(env.npm_config_userconfig,'',{mode:0o600});
 function run(command,args,cwd,expected=0){
  const output=join(temporary,'command.stdout'),errors=join(temporary,'command.stderr');
  const out=openSync(output,'w',0o600),err=openSync(errors,'w',0o600);let child;
  try{child=spawnSync(command,args,{cwd,env,stdio:['ignore',out,err],timeout:60000});}
  finally{closeSync(out);closeSync(err);}
  if(child.error||child.status!==expected)throw new Error(`portable ${command===process.execPath?'node':command} failed (expected ${expected}, actual ${child.status})`);
  const bytes=readFileSync(output);if(bytes.length>4*1024*1024)throw new Error('verification output bound exceeded');return bytes.toString('utf8');
 }
 try{
  const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',temporary],root))[0];
  const archive=join(temporary,packed.filename),extracted=join(temporary,'extract');mkdirSync(extracted);
  run('tar',['-xzf',archive,'-C',extracted],temporary);
  const pkg=join(extracted,'package'),bin=join(pkg,'bin/agent-token-optimizer.mjs'),commands=[];
  const cli=(name,args,expected=0)=>{const value=JSON.parse(run(process.execPath,[bin,...args],temporary,expected));commands.push(name);return value;};
  const manifest=JSON.parse(readFileSync(join(pkg,'package.json')));
  if(existsSync(join(pkg,'node_modules'))||!existsSync(join(pkg,'openclaw.plugin.json')))throw new Error('packaged root is incomplete');
  const entry=manifest.openclaw.extensions[0];if(!existsSync(resolve(pkg,entry))||!resolve(pkg,entry).startsWith(pkg+'/'))throw new Error('entry outside package');
  const core=pathToFileURL(join(pkg,'packages/openclaw-token-efficiency/src/index.mjs')).href;
  run(process.execPath,['--input-type=module','-e',`const core=await import(${JSON.stringify(core)}); if(typeof core.UsageLedger!=='function')throw Error('export');`],temporary);commands.push('core-import');
  const local=join(temporary,'local'),config=join(local,'deployment.json');
  cli('init',['init','--directory',local]);
  const policy=cli('policy dry-run',['policy','dry-run','--config',config,'--agent-id','random-portable-id']);if(policy.effectiveMode!=='observe')throw new Error('unsafe default');
  cli('collect-unknown',['collect','--config',config],2);cli('report-unknown',['report','--config',config],2);
  const dataset=join(temporary,'input.json');writeFileSync(dataset,'{}');const evaluated=cli('evaluate',['evaluate','--input',dataset]);if(evaluated.claimsPermitted!==false)throw new Error('unauthenticated evidence');
  cli('verify',['verify','--config',config]);
  const demo=JSON.parse(run(process.execPath,[join(pkg,'scripts/demo.mjs')],temporary));commands.push('demo');
  cli('collect',['collect','--config',demo.config]);cli('report',['report','--config',demo.config]);
  // Keep no temporary demo/state outside this verification tree.
  rmSync(dirname(demo.config),{recursive:true,force:true});
  return {ok:true,noWorkspaceDependencies:true,realModelRequests:0,commands,integrity:packed.integrity,shasum:packed.shasum,packedFileCount:packed.entryCount,...keepDirectory?{directory:temporary,packageDirectory:pkg,archive}:{} };
 }finally{if(!keepDirectory)rmSync(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{writeSync(1,JSON.stringify(await verifyPackage({keepDirectory:process.argv.includes('--keep')}),null,2)+'\n');}
 catch{writeSync(2,'Fresh package verification failed.\n');process.exitCode=1;}
}
