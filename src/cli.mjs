import {mkdirSync,writeFileSync,existsSync,readFileSync,lstatSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {resolvePolicy,validatePolicy,discoverSources,normalizeUsage,readReport,evaluatePairedResults} from '../packages/openclaw-token-efficiency/src/index.mjs';
import {collectDeployment,loadDeployment} from './collector.mjs';

export const HELP=`Usage: agent-token-optimizer <command> [options]
  init --directory DIR                  Create private observe-only deployment
  policy dry-run --config FILE [--agent-id ID --session-id ID --run-id ID]
  collect --config FILE                 Explicit local sources only
  report --config FILE                  Read saved local snapshot; never collect
  verify [--config FILE]                Offline contract/config check, no host proof
  evaluate --input FILE                 Unauthenticated JSON evaluation, no models
Exit codes: 0 completed, 1 invalid input/error, 2 no current collection/report.
No model calls, production edits, recurring jobs, runtime gates or hard billing cap.
`;
function flags(args,allowed){
 const out={};for(let i=0;i<args.length;i+=2){const key=args[i];if(!allowed.includes(key)||Object.hasOwn(out,key)||!args[i+1]||args[i+1].startsWith('--'))throw new TypeError('invalid arguments');out[key]=args[i+1];}return out;
}
const json=path=>JSON.parse(readFileSync(path,'utf8'));
export function initialize(directory){
 const target=resolve(directory),paths=['deployment.json','policy.json'].map(x=>join(target,x));
 if(paths.some(existsSync)||existsSync(target)&&lstatSync(target).isSymbolicLink())throw new Error('refuse existing config or symlink');
 mkdirSync(target,{recursive:true,mode:0o700});
 const deployment={version:1,policy:'policy.json',ledger:'state/usage.sqlite',reportDirectory:'report',staleAfterMs:900000,sources:[]};
 const policy={version:1,defaults:{mode:'observe'},profiles:{},bindings:[]};
 for(const [i,data]of [deployment,policy].entries())writeFileSync(paths[i],JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 return {directory:target,config:paths[0],policy:paths[1],mode:'observe',sources:0};
}
/** Pure command dispatch plus explicit filesystem actions. No SDK dependency. */
export async function runCli(args){
 if(!args.length||args.length===1&&['--help','-h'].includes(args[0]))return {code:0,text:HELP};
 const command=args.shift();
 if(command==='init'){const f=flags(args,['--directory']);return {code:0,value:initialize(f['--directory']??'ato-local')};}
 if(command==='policy'){
  if(args.shift()!=='dry-run')throw new TypeError('invalid policy command');
  const f=flags(args,['--config','--agent-id','--session-id','--run-id']);if(!f['--config'])throw new TypeError('config required');
  const deployment=loadDeployment(f['--config']);
  return {code:0,value:resolvePolicy(json(deployment.policy),{agentId:f['--agent-id'],sessionId:f['--session-id'],runId:f['--run-id']})};
 }
 if(command==='collect'||command==='report'){
  const f=flags(args,['--config']);if(!f['--config'])throw new TypeError('config required');
  if(command==='collect'){const result=await collectDeployment(f['--config']);return {code:result.ok?0:2,value:result};}
  const d=loadDeployment(f['--config']),result=readReport(d.reportDirectory);return {code:['stale','unknown'].includes(result.status)?2:0,value:result};
 }
 if(command==='verify'){
  const f=flags(args,['--config']);let sources=[];
  if(f['--config']){const d=loadDeployment(f['--config']);validatePolicy(json(d.policy));sources=discoverSources(d).sources.map(({id,status,reasons})=>({id,status,reasons}));}
  const probe=normalizeUsage({input:3,output:1},{fields:{input:'input',output:'output'},inputIncludesCacheRead:false,inputIncludesCacheWrite:false});
  if(probe.uncachedInput!==3||probe.cacheRead!==null)throw new Error('contract failed');
  return {code:0,value:{ok:true,kind:'offline-contract-check',hostEnforcement:'unverified',realModelRequests:0,sources}};
 }
 if(command==='evaluate'){
  const f=flags(args,['--input']);if(!f['--input'])throw new TypeError('input required');
  return {code:0,value:evaluatePairedResults(json(resolve(f['--input'])))};
 }
 throw new TypeError('invalid command');
}
