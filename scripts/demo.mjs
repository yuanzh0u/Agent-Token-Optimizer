import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeSync} from 'node:fs';
import {initialize} from '../src/cli.mjs';
import {collectDeployment} from '../src/collector.mjs';
import {writeReport} from '../packages/openclaw-token-efficiency/src/index.mjs';

export async function demo(directory){
 const target=directory?resolve(directory):mkdtempSync(join(tmpdir(),'ato-synthetic-demo-'));
 const init=initialize(target),config=JSON.parse(readFileSync(init.config,'utf8'));
 config.sources=[{id:'SYNTHETIC-offline-fixture',type:'jsonl',path:'events.jsonl',conversationAccess:true,mapping:{fields:{input:'usage.input',output:'usage.output',cacheRead:'usage.cacheRead',cacheWrite:'usage.cacheWrite'},inputIncludesCacheRead:false,inputIncludesCacheWrite:false,metadata:{sourceRecordKey:'id',provider:'provider',model:'model',agentId:'agentId',sessionId:'sessionId',runId:'runId',runtime:'runtime'}}}];
 writeFileSync(join(target,'events.jsonl'),JSON.stringify({id:'synthetic-1',provider:'SYNTHETIC-no-provider-called',model:'<synthetic-model>',agentId:'arbitrary-agent-42',sessionId:'synthetic-session',runId:'synthetic-run',runtime:'offline-fixture',usage:{input:120,output:20,cacheRead:40,cacheWrite:0}})+'\n',{mode:0o600});
 writeFileSync(init.config,JSON.stringify(config,null,2)+'\n',{mode:0o600});
 const result=await collectDeployment(init.config);if(!result.ok)throw new Error('demo collection failed');
 const published=await writeReport({directory:join(target,'report'),synthetic:true,collect:()=>result.report.snapshot.summary});
 if(published.error)throw new Error('demo publication failed');
 return {kind:'synthetic-demo',synthetic:true,realModelRequests:0,config:init.config,...published.paths};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--directory'))throw new Error('usage');writeSync(1,JSON.stringify(await demo(args[1]),null,2)+'\n');}
 catch{writeSync(2,'Synthetic demo failed; use an empty --directory DIR.\n');process.exitCode=1;}
}
