import { DIMENSIONS, tokenCount } from './usage.mjs';

const ARMS = ['baseline', 'candidate'];
const STRATUM = ['task', 'model', 'thinking', 'cache', 'workload'];
const PURPOSES = new Set(['primary', 'retry', 'summary', 'retrieval', 'fallback']);
const vector = value => Object.fromEntries(DIMENSIONS.map(key => [key, value]));
const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

// Provenance verification is an explicit trusted adapter boundary, not a JSON
// claim. Async verification is rejected without leaking rejected promises.
function verified(verifier, ...args) {
  if (typeof verifier !== 'function') return false;
  try {
    const result = verifier(...args);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      return false;
    }
    return result === true;
  } catch { return false; }
}

/**
 * Pure paired arithmetic/gates. Canonical usage comes from core normalization or
 * a trusted ledger. `verifyEvidence(request,run,pair,arm)` must authenticate each
 * complete provider measurement, not merely trust a sourceKind/evidenceRef label.
 * Unit/synthetic fixtures always stay synthetic, even with numeric usage fields.
 */
export function evaluatePairedResults(dataset = {}, { verifyEvidence, verifySoak, now = Date.now() } = {}) {
  const reasons = new Set();
  const add = reason => reasons.add(reason);
  const pairs = Array.isArray(dataset.pairs) ? dataset.pairs : [];
  const totals = { baseline: vector(0), candidate: vector(0) };
  const latency = { baseline: [], candidate: [] };
  const failedRequests = { baseline: 0, candidate: 0 };
  const fallbackRequests = { baseline: 0, candidate: 0 };
  const successes = { baseline: 0, candidate: 0 };
  const seenPairs = new Set(), seenEvidence = new Set();
  let fixedStratum;
  if (dataset.synthetic === true) add('synthetic-results');
  else if (dataset.synthetic !== false) add('unverified-origin');
  if (!pairs.length) add('empty-baseline');
  if (!nonnegative(dataset.expectedPairCount) || dataset.expectedPairCount !== pairs.length) add('missing-samples');
  if (pairs.length < 20) add('insufficient-validation-pairs');
  if (dataset.heldout?.independent !== true || dataset.heldout?.untuned !== true ||
      typeof dataset.heldout?.evidenceRef !== 'string' || !dataset.heldout.evidenceRef.length) add('heldout-unverified');

  for (const pair of pairs) {
    if (typeof pair?.id !== 'string' || !pair.id || seenPairs.has(pair.id)) add('duplicate-or-missing-pair-id');
    seenPairs.add(pair?.id);
    for (const arm of ARMS) {
      const run = pair?.[arm];
      if (!run || typeof run !== 'object') {
        add('missing-samples');
        for (const key of DIMENSIONS) totals[arm][key] = null;
        continue;
      }
      const strata = STRATUM.map(key => run.stratum?.[key]);
      if (strata.some(value => typeof value !== 'string' || !value.length)) add('stratum-mismatch');
      const key = JSON.stringify(strata);
      fixedStratum ??= key;
      if (key !== fixedStratum) add('stratum-mismatch');
      if (run.sourceKind !== 'provider-measured') add('unverified-provider-evidence');
      if (run.coverage !== 'complete') add('incomplete-coverage');
      if (typeof run.success !== 'boolean' || run.criticalFacts !== true || !nonnegative(run.sideEffectCount)) add('quality-evidence-missing-or-regressed');
      if (run.success === true) successes[arm]++;
      if (nonnegative(run.latencyMs)) latency[arm].push(run.latencyMs);
      else add('missing-latency');
      const requests = Array.isArray(run.requests) ? run.requests : [];
      if (!requests.length || !nonnegative(run.expectedRequests) || run.expectedRequests !== requests.length) add('missing-samples');
      if (!requests.length) for (const dimension of DIMENSIONS) totals[arm][dimension] = null;
      for (const request of requests) {
        if (!request || !PURPOSES.has(request.purpose) || !['success', 'failed', 'cancelled'].includes(request.status)) add('missing-request-outcome');
        if (request?.status === 'failed' || request?.status === 'cancelled') failedRequests[arm]++;
        if (request?.purpose === 'fallback') fallbackRequests[arm]++;
        if (typeof request?.evidenceRef !== 'string' || !request.evidenceRef || seenEvidence.has(request.evidenceRef)) add('duplicate-or-missing-request-evidence');
        seenEvidence.add(request?.evidenceRef);
        if (!verified(verifyEvidence, request, run, pair, arm)) add('unverified-provider-evidence');
        for (const dimension of DIMENSIONS) {
          let count;
          try { count = tokenCount(request?.usage?.[dimension]); }
          catch { count = null; }
          if (count === null) { add('unknown-usage'); totals[arm][dimension] = null; }
          else if (totals[arm][dimension] !== null) {
            if (!Number.isSafeInteger(totals[arm][dimension] + count)) {
              add('usage-overflow'); totals[arm][dimension] = null;
            } else totals[arm][dimension] += count;
          }
        }
      }
    }
    if (pair?.baseline && pair?.candidate && (
      (pair.baseline.success === true && pair.candidate.success !== true) ||
      pair.candidate.criticalFacts !== true || pair.baseline.sideEffectCount !== pair.candidate.sideEffectCount
    )) add('quality-regression');
  }
  if (!successes.baseline) add('no-successful-baseline');
  if (!pairs.length) for (const arm of ARMS) totals[arm] = vector(null);
  const p95Ms = { baseline: p95(latency.baseline), candidate: p95(latency.candidate) };
  if (p95Ms.baseline !== null && p95Ms.candidate !== null && p95Ms.candidate > p95Ms.baseline * 1.2) add('p95-degradation');
  const complete = ARMS.every(arm => DIMENSIONS.every(key => totals[arm][key] !== null));
  const nonzeroBaseline = complete && DIMENSIONS.some(key => totals.baseline[key] > 0);
  if (complete && !nonzeroBaseline) add('zero-baseline');
  const eligible = reasons.size === 0;
  const vectorImprovement = eligible && nonzeroBaseline ?
    DIMENSIONS.every(key => totals.candidate[key] <= totals.baseline[key]) &&
    DIMENSIONS.some(key => totals.candidate[key] < totals.baseline[key]) : null;

  let cost = null, savingsRate = null;
  const pricing = dataset.pricing;
  if (pricing) {
    const valid = typeof pricing.currency === 'string' && /^[A-Z]{3}$/.test(pricing.currency) &&
      DIMENSIONS.every(key => typeof pricing.perMillion?.[key] === 'number' && Number.isFinite(pricing.perMillion[key]) && pricing.perMillion[key] >= 0);
    if (!valid) add('invalid-pricing');
    else if (eligible && nonzeroBaseline) {
      const amounts = Object.fromEntries(ARMS.map(arm => [arm,
        DIMENSIONS.reduce((sum, key) => sum + totals[arm][key] * pricing.perMillion[key] / 1000000, 0),
      ]));
      if (Number.isFinite(amounts.baseline) && Number.isFinite(amounts.candidate) && amounts.baseline > 0) {
        cost = { ...amounts, currency: pricing.currency };
        savingsRate = (amounts.baseline - amounts.candidate) / amounts.baseline;
      } else add('zero-or-invalid-priced-baseline');
    }
  }
  const soakGates = { 24: 'pending', 48: 'pending', 72: 'pending' };
  for (const evidence of Array.isArray(dataset.soakEvidence) ? dataset.soakEvidence : []) {
    if (dataset.synthetic !== false || evidence?.passed !== true || !nonnegative(evidence.startedAt) || !nonnegative(evidence.endedAt) ||
        evidence.endedAt > now || evidence.startedAt > evidence.endedAt ||
        typeof evidence.evidenceRef !== 'string' || !evidence.evidenceRef || !verified(verifySoak, evidence)) continue;
    for (const hours of [24, 48, 72]) {
      if (evidence.endedAt - evidence.startedAt >= hours * 3600000) soakGates[hours] = 'pass';
    }
  }
  const excluded = [...reasons].some(reason => [
    'quality-regression', 'quality-evidence-missing-or-regressed', 'p95-degradation', 'missing-latency',
    'missing-samples', 'incomplete-coverage', 'unknown-usage', 'stratum-mismatch',
  ].includes(reason));
  return {
    kind: dataset.synthetic === true ? 'synthetic-evaluation' : 'paired-evaluation',
    pairCount: pairs.length, stage: pairs.length >= 20 ? 'validation' : pairs.length >= 5 ? 'screening' : 'insufficient',
    excluded, claimsPermitted: reasons.size === 0 && (pricing ? savingsRate !== null && savingsRate > 0 : vectorImprovement === true),
    reasons: [...reasons], totals, successes, failedRequests, fallbackRequests, p95Ms,
    vectorImprovement, cost, savingsRate, soakGates,
    rolloutReady: false, // Elapsed gates alone do not establish adoption/host readiness.
  };
}
