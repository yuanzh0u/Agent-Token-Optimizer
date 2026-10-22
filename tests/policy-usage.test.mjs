import test from 'node:test';
import assert from 'node:assert/strict';
const policy = await import('../packages/openclaw-token-efficiency/src/policy.mjs').catch(()=>({}));
const usage = await import('../packages/openclaw-token-efficiency/src/usage.mjs').catch(()=>({}));
const caps = await import('../packages/openclaw-token-efficiency/src/capabilities.mjs').catch(()=>({}));
const id = {agentId:'opaque-a',sessionId:'s1',runId:'r1'};
const scope = {hostVersion:'v1',runtime:'node',provider:'vendor',workClass:'interactive'};
const config = () => ({version:1,defaults:{mode:'observe'},profiles:{work:{mode:'enforce',features:{requestGate:true},limits:{windowTokens:1000,outputReserveTokens:100,safetyMarginTokens:50}}},bindings:[{id:'one',agentId:'opaque-a',profile:'work'}]});
test('policy binds exact identity with provenance and verified scoped evidence',()=>{
 assert.equal(typeof policy.resolvePolicy,'function','policy resolver must exist');
 const result=policy.resolvePolicy(config(),id,{requestGate:{status:'verified',scope,evidenceRef:'offline-fixture',requestGate:true}},scope);
 assert.equal(result.effectiveMode,'enforce'); assert.equal(result.softContextLimit,850);
 assert.equal(result.provenance.mode,'profile:work'); assert.equal(result.bindingId,'one');
 result.policy.features.requestGate=false;
 assert.equal(policy.resolvePolicy(config(),id,{},scope).policy.features.requestGate,true);
});
test('renaming display labels has no effect; unbound/missing identities cannot intervene',()=>{
 assert.equal(typeof policy.resolvePolicy,'function');
 const cfg=config(); const renamed=policy.resolvePolicy(cfg,{...id,name:'renamed'},{},scope);
 assert.equal(renamed.bindingId,'one'); assert.equal(renamed.effectiveMode,'observe');
 const unbound=policy.resolvePolicy(cfg,{...id,agentId:'backend'},{},scope);
 assert.equal(unbound.bindingId,null); assert.equal(unbound.effectiveMode,'observe');
 assert.notDeepEqual(unbound.scope,renamed.scope);
 assert.equal(policy.resolvePolicy(cfg,{agentId:'opaque-a'}).effectiveMode,'observe');
});
test('multiple binding matches and unverified controls explicitly reject intervention',()=>{
 const cfg=config(); cfg.bindings.push({id:'two',agentId:'opaque-a',runId:'r1',profile:'work'});
 assert.equal(typeof policy.resolvePolicy,'function'); const r=policy.resolvePolicy(cfg,id,{},scope);
 assert.equal(r.effectiveMode,'observe'); assert.match(r.unsupportedReasons.join(' '),/multiple/);
 const noProof=policy.resolvePolicy(config(),id,{requestGate:{status:'verified',scope:{...scope,hostVersion:'other'},evidenceRef:'x',requestGate:true}},scope);
 assert.equal(noProof.effectiveMode,'observe'); assert.match(noProof.unsupportedReasons.join(' '),/scope/);
});
test('binding overrides defaults/profile; partial limits stay unknown; permissions cannot expand',()=>{
 assert.equal(typeof policy.resolvePolicy,'function'); const cfg=config();
 cfg.bindings[0].overrides={mode:'observe',permissions:['read']};
 const result=policy.resolvePolicy(cfg,id,{}, {...scope,permissions:['read']});
 assert.equal(result.provenance.mode,'binding:one'); assert.equal(result.effectiveMode,'observe');
 cfg.bindings[0].overrides.permissions.push('write');
 assert.throws(()=>policy.resolvePolicy(cfg,id,{}, {...scope,permissions:['read']}),/permission/);
 delete cfg.profiles.work.limits.safetyMarginTokens;
 cfg.bindings[0].overrides.permissions=['read'];
 assert.equal(policy.resolvePolicy(cfg,id,{}, {...scope,permissions:['read']}).softContextLimit,null);
});
test('invalid versions, unknown controls and forbidden host settings reject the entire policy',()=>{
 assert.equal(typeof policy.resolvePolicy,'function');
 for(const invalid of [{...config(),version:2},{...config(),typo:true}, {...config(),defaults:{mode:'enfroce'}}, {...config(),defaults:{features:{mystery:true}}}, {...config(),profiles:{work:{contextEngine:'x'}}}, {...config(),defaults:{limits:{windowTokens:-1}}}]) assert.throws(()=>policy.resolvePolicy(invalid,id));
});
test('capability requires exact scope and evidence; SDK alone partial, L3 needs a real request gate',()=>{
 assert.equal(typeof caps.evaluateCapability,'function');
 assert.equal(caps.evaluateCapability({x:{sdkPresent:true}},'x',scope).status,'partial');
 assert.equal(caps.evaluateCapability({},'x',scope).status,'unsupported');
 assert.equal(caps.evaluateCapability({requestGate:{status:'verified',scope,evidenceRef:'x'}},'requestGate',scope).status,'unsupported');
 assert.equal(caps.evaluateCapability({x:{status:'verified',scope,evidenceRef:'x'}},'x',scope).status,'verified');
 assert.notEqual(caps.evaluateCapability({x:{status:'verified',scope,evidenceRef:'x'}},'x',{...scope,provider:'else'}).status,'verified');
});
const mapping={fields:{input:'in',output:'out',cacheRead:'hit',cacheWrite:'write'},inputIncludesCacheRead:true,inputIncludesCacheWrite:true,metadata:{sourceRecordKey:'key',provider:'provider',accountId:'account',requestId:'request',agentId:'agent',sessionId:'session',runId:'run'}};
test('explicit cache semantics normalize golden 140/15/900/20 and remove bodies',()=>{
 assert.equal(typeof usage.normalizeUsage,'function');
 const result=usage.normalizeUsage({in:1060,out:15,hit:900,write:20,key:'one',provider:'p',account:'a',request:'r',prompt:'SECRET',response:'SECRET'},mapping);
 assert.deepEqual([result.uncachedInput,result.output,result.cacheRead,result.cacheWrite],[140,15,900,20]);
 assert.equal(result.sourceRecordKey,'one'); assert.equal(result.provider,'p'); assert.ok(!JSON.stringify(result).includes('SECRET'));
 const exclusive=usage.normalizeUsage({in:140,out:15,hit:900,write:20},{...mapping,inputIncludesCacheRead:false,inputIncludesCacheWrite:false});
 assert.equal(exclusive.uncachedInput,140);
});
test('unknown dimensions remain null and invalid provider numbers/ambiguous mappings reject',()=>{
 assert.equal(typeof usage.normalizeUsage,'function');
 const result=usage.normalizeUsage({in:1060},mapping);
 assert.deepEqual([result.uncachedInput,result.output,result.cacheRead,result.cacheWrite],[null,null,null,null]);
 for(const value of [-1,1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'2']) assert.throws(()=>usage.normalizeUsage({in:value},mapping));
 assert.throws(()=>usage.normalizeUsage({in:3,hit:4,write:0},mapping),/negative/);
 assert.throws(()=>usage.normalizeUsage({in:4},{fields:{input:'in'}}),/semantics/);
 assert.throws(()=>usage.normalizeUsage({in:4},{...mapping,fields:{input:'in',characters:'text'}}),/mapping/);
});

test('explicit defaults null is invalid while absent defaults remain allowed',()=>{
 assert.throws(()=>policy.resolvePolicy({...config(),defaults:null},id),/shape/);
 const absent=config();delete absent.defaults;assert.equal(policy.resolvePolicy(absent,{agentId:'unbound'}).effectiveMode,'observe');
});
