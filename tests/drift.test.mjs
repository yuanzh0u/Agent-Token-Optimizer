import test from 'node:test';
import assert from 'node:assert/strict';
const drift=await import('../packages/openclaw-token-efficiency/src/drift.mjs').catch(()=>({}));
test('fingerprints detect secret changes while public snapshots expose no credentials',()=>{
 assert.equal(typeof drift.fingerprint,'function');
 const a={plugins:{key:'x'},apiKey:'highly-secret',nested:{password:'private'}};
 const publicConfig=drift.redactConfig(a);
 assert.ok(!JSON.stringify(publicConfig).includes('highly-secret'));
 assert.ok(!JSON.stringify(publicConfig).includes('private'));
 assert.notEqual(drift.fingerprint(a),drift.fingerprint({...a,apiKey:'changed'}));
 assert.equal(drift.fingerprint({a:1,b:2}),drift.fingerprint({b:2,a:1}));
});
test('hash-guarded rollback preserves unset engine and independent later edits',()=>{
 assert.equal(typeof drift.planPatch,'function');
 const base={other:1}; const patch=drift.planPatch(base,[{path:['contextEngine'],value:'candidate'}],drift.fingerprint(base));
 assert.ok(!Object.hasOwn(base,'contextEngine'));
 assert.equal(patch.config.contextEngine,'candidate');
 assert.deepEqual(drift.rollbackPatch({...patch.config,other:2},patch.receipt),{other:2});
 assert.throws(()=>drift.planPatch({...base,other:3},[{path:['contextEngine'],value:'x'}],drift.fingerprint(base)),/hash|drift/);
 assert.throws(()=>drift.rollbackPatch({...patch.config,contextEngine:'changed'},patch.receipt),/owned|changed/);
});
test('rollback preserves explicit legacy/custom engine and rejects unsafe/overlapping paths',()=>{
 assert.equal(typeof drift.planPatch,'function');
 for(const engine of ['legacy','custom',null]) {
  const base={contextEngine:engine}; const p=drift.planPatch(base,[{path:['contextEngine'],unset:true}],drift.fingerprint(base));
  assert.deepEqual(drift.rollbackPatch(p.config,p.receipt),base);
 }
 for(const path of [['__proto__','polluted'],['constructor','prototype','x'],[],['x',0]]) assert.throws(()=>drift.planPatch({},[{path,value:1}],drift.fingerprint({})));
 assert.throws(()=>drift.planPatch({},[{path:['x'],value:{}},{path:['x','y'],value:2}],drift.fingerprint({})),/overlap/);
 assert.equal({}.polluted,undefined);
});
test('rollback does not recreate an independently removed parent object',()=>{
 const base={plugins:{token:{enabled:true}},other:1};
 const p=drift.planPatch(base,[{path:['plugins','token','enabled'],unset:true}],drift.fingerprint(base));
 assert.throws(()=>drift.rollbackPatch({plugins:{},other:2},p.receipt),/parent|changed/);
});

test('public snapshots hash common credential keys and credential-bearing URLs',()=>{
 const config={accessKey:'SYNTHETIC-ACCESS-SECRET',privateKey:'SYNTHETIC-PRIVATE-MATERIAL',nested:{access_key:'SYNTHETIC-ACCESS-UNDERSCORE','private-key':'SYNTHETIC-PRIVATE-HYPHEN'},baseUrl:'https://SYNTHETIC-USER:SYNTHETIC-URL-PASSWORD@example.test/?key=SYNTHETIC-URL-KEY',urls:['https://example.test/?access_key=SYNTHETIC-QUERY-ACCESS','https://example.test/?api-key=SYNTHETIC-QUERY-API'],safeUrl:'https://example.test/path?region=us'};
 const output=JSON.stringify(drift.redactConfig(config));
 for(const secret of ['SYNTHETIC-ACCESS-SECRET','SYNTHETIC-PRIVATE-MATERIAL','SYNTHETIC-ACCESS-UNDERSCORE','SYNTHETIC-PRIVATE-HYPHEN','SYNTHETIC-USER','SYNTHETIC-URL-PASSWORD','SYNTHETIC-URL-KEY','SYNTHETIC-QUERY-ACCESS','SYNTHETIC-QUERY-API'])assert.ok(!output.includes(secret),`public snapshot exposed ${secret}`);
 assert.equal(drift.redactConfig(config).safeUrl,config.safeUrl);
 for(const key of ['accessKey','privateKey','baseUrl'])assert.notEqual(drift.fingerprint(config),drift.fingerprint({...config,[key]:config[key]+'-changed'}));
});
