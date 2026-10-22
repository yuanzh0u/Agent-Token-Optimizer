import test from 'node:test';
import assert from 'node:assert/strict';
const portable=await import('../scripts/verify-package.mjs').catch(()=>({}));
test('fresh npm tarball runs core, init, policy, collect/report, evaluate, verify and demo without workspace dependencies',async()=>{
 assert.equal(typeof portable.verifyPackage,'function');
 const result=await portable.verifyPackage();
 assert.equal(result.ok,true);assert.equal(result.noWorkspaceDependencies,true);assert.equal(result.realModelRequests,0);
 assert.deepEqual(result.commands,['core-import','init','policy dry-run','collect-unknown','report-unknown','evaluate','verify','demo','collect','report']);
 assert.match(result.integrity,/^sha512-/);
});
