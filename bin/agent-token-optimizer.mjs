#!/usr/bin/env node
import {writeSync} from 'node:fs';
import {runCli} from '../src/cli.mjs';
try{
 const result=await runCli(process.argv.slice(2));
 writeSync(1,result.text??JSON.stringify(result.value,null,2)+'\n');process.exitCode=result.code;
}catch{
 // Error text can include source bodies, filesystem names or credentials.
 writeSync(2,'Invalid command/config or local operation failed. Use --help; inspect explicit paths and schema.\n');process.exitCode=1;
}
