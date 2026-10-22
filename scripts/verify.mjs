import {spawnSync} from 'node:child_process';
import {readdirSync,writeSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
try{
 const lock=JSON.parse(readFileSync(join(root,'evidence/version-lock.json'),'utf8'));
 for(const [path,hash]of Object.entries(lock.projectSourceSha256))if(createHash('sha256').update(readFileSync(join(root,path))).digest('hex')!==hash)throw new Error('source lock mismatch');
 const tests=readdirSync(join(root,'tests')).filter(x=>x.endsWith('.test.mjs')).sort().map(x=>join(root,'tests',x));
 const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--test','--test-isolation=none',...tests],{cwd:root,stdio:'inherit',timeout:180000});
 if(child.error||child.status!==0)throw new Error('suite failed');
 writeSync(1,'Verified offline tests, source lock and fresh package portability. Host gates, paid request coverage and rollout remain pending.\n');
}catch{writeSync(2,'Verification failed (source lock or offline suite).\n');process.exitCode=1;}
