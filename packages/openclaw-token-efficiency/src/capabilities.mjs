/** Exact evidence scope; host upgrades invalidate verified capabilities. */
export const EVIDENCE_SCOPE_KEYS = Object.freeze(['hostVersion','runtime','provider','workClass']);
/**
 * Evaluate one capability conservatively. Evidence is supplied by a trusted host probe,
 * never inferred from package presence. L3/requestGate needs an actual request gate.
 * @param {object} capabilities map of feature -> evidence
 * @param {string} feature
 * @param {object} scope exact hostVersion/runtime/provider/workClass
 * @returns {{status:string,reasons:string[],evidenceRef:string|null}}
 */
export function evaluateCapability(capabilities, feature, scope = {}) {
 const e = Object.hasOwn(capabilities ?? {},feature) ? capabilities[feature] : null;
 const evidenceRef=typeof e?.evidenceRef==='string' && e.evidenceRef.length ? e.evidenceRef : null;
 if(!e) return {status:'unsupported',reasons:['missing capability evidence'],evidenceRef};
 if((feature==='requestGate'||feature==='L3') && e.requestGate!==true) return {status:'unsupported',reasons:['actual request gate not demonstrated'],evidenceRef};
 const exact=EVIDENCE_SCOPE_KEYS.every(k=>typeof scope[k]==='string' && scope[k].length>0 && e.scope?.[k]===scope[k]);
 if(e.status==='verified' && exact && evidenceRef) return {status:'verified',reasons:[],evidenceRef};
 return {status:e.sdkPresent===true || e.status==='partial' ? 'partial':'unsupported',reasons:[!exact ? 'capability scope missing or mismatched' : 'verified evidenceRef required'],evidenceRef};
}
