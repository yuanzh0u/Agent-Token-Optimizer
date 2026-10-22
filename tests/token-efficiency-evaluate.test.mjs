import test from 'node:test';
import assert from 'node:assert/strict';
import * as evaluator from '../scripts/token-efficiency-evaluate.mjs';

const dimensions = ['uncachedInput', 'output', 'cacheRead', 'cacheWrite'];
const stratum = { task: 'fixed-task', model: 'fixed-model', thinking: 'medium', cache: 'warm', workload: 'inventory' };
const usage = (input = 100) => ({ uncachedInput: input, output: 10, cacheRead: 20, cacheWrite: 0 });
let evidenceId = 0;
const request = (input = 100, extra = {}) => ({ purpose: 'primary', status: 'success', evidenceRef: `trusted-ledger-row-${++evidenceId}`, usage: usage(input), ...extra });
const run = input => ({ stratum: { ...stratum }, sourceKind: 'provider-measured', coverage: 'complete', expectedRequests: 1,
  success: true, criticalFacts: true, sideEffectCount: 1, latencyMs: 100, requests: [request(input)] });
const data = (n = 20) => ({ expectedPairCount: n, synthetic: false,
  heldout: { independent: true, untuned: true, evidenceRef: 'heldout-selection-record' },
  pairs: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, baseline: run(100), candidate: run(80) })) });
// A trust-boundary stub exercises eligibility arithmetic. These unit samples are
// fictional and never published as provider measurements or experimental gains.
const trusted = { verifyEvidence: () => true };
const evaluate = (value, options = trusted) => evaluator.evaluatePairedResults(value, options);

test('paired evaluator API exists', () => assert.equal(typeof evaluator.evaluatePairedResults, 'function'));

test('numeric fixtures alone never become actual measurements or savings claims', () => {
  const untrusted = evaluate(data(), {});
  assert.equal(untrusted.claimsPermitted, false);
  assert.ok(untrusted.reasons.includes('unverified-provider-evidence'));
  const synthetic = data(); synthetic.synthetic = true;
  const result = evaluate(synthetic);
  assert.equal(result.claimsPermitted, false);
  assert.equal(result.vectorImprovement, null);
  assert.ok(result.reasons.includes('synthetic-results'));
});

test('all four dimensions nonincrease with one decrease permits vector-only improvement', () => {
  const result = evaluate(data());
  assert.equal(result.claimsPermitted, true);
  assert.equal(result.vectorImprovement, true);
  assert.equal(result.savingsRate, null);
  assert.equal(result.cost, null);
  assert.equal(result.totals.baseline.uncachedInput, 2000);
  assert.equal(result.totals.candidate.uncachedInput, 1600);
});

test('a tradeoff in any dimension forbids an unpriced savings claim', () => {
  const input = data(); input.pairs[0].candidate.requests[0].usage.cacheWrite = 1;
  const result = evaluate(input);
  assert.equal(result.vectorImprovement, false);
  assert.equal(result.savingsRate, null);
  assert.equal(result.claimsPermitted, false);
});

test('explicit pricing may evaluate a tradeoff but never removes quality gates', () => {
  const input = data(); input.pairs[0].candidate.requests[0].usage.cacheWrite = 1;
  input.pricing = { currency: 'USD', perMillion: { uncachedInput: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } };
  const result = evaluate(input);
  assert.equal(result.claimsPermitted, true);
  assert.ok(result.savingsRate > 0);
  assert.equal(result.cost.currency, 'USD');
  input.pairs[0].candidate.criticalFacts = false;
  assert.equal(evaluate(input).savingsRate, null);
});

test('failed requests, fallback, retries, summaries and retrievals are included', () => {
  const input = data();
  for (const pair of input.pairs) {
    pair.candidate.requests = ['primary', 'summary', 'retrieval', 'retry', 'fallback'].map((purpose, index) => request(index === 0 ? 80 : 10, { purpose, status: index === 3 ? 'failed' : 'success' }));
    pair.candidate.expectedRequests = 5;
  }
  const result = evaluate(input);
  assert.equal(result.totals.candidate.uncachedInput, 2400);
  assert.equal(result.failedRequests.candidate, 20);
  assert.equal(result.fallbackRequests.candidate, 20);
  assert.equal(result.vectorImprovement, false);
});

test('null dimensions and incomplete/missing samples prohibit conclusions', () => {
  for (const mutate of [
    input => { input.pairs[0].candidate.requests[0].usage.cacheRead = null; },
    input => { input.pairs[0].candidate.coverage = 'partial'; },
    input => { input.expectedPairCount++; },
    input => { input.pairs[0].candidate.expectedRequests++; },
    input => { input.pairs[0].candidate.requests[0].usage.output = -1; },
    input => { input.pairs[0].candidate.requests = []; input.pairs[0].candidate.expectedRequests = 0; },
    input => { delete input.pairs[0].candidate; },
  ]) {
    const input = data(); mutate(input);
    assert.equal(evaluate(input).claimsPermitted, false);
    assert.equal(evaluate(input).savingsRate, null);
  }
});

test('mismatched task/model/thinking/cache/workload strata cannot be aggregated', () => {
  for (const key of Object.keys(stratum)) {
    const input = data(); input.pairs[0].candidate.stratum[key] = 'different';
    assert.ok(evaluate(input).reasons.includes('stratum-mismatch'));
  }
  const input = data(); input.pairs[1].baseline.stratum.task = 'other'; input.pairs[1].candidate.stratum.task = 'other';
  assert.ok(evaluate(input).reasons.includes('stratum-mismatch'));
});

test('quality regression excludes candidates without dropping failure pairs', () => {
  for (const mutate of [
    run => { run.criticalFacts = false; }, run => { run.success = false; }, run => { run.sideEffectCount++; },
  ]) {
    const input = data(); mutate(input.pairs[0].candidate);
    const result = evaluate(input);
    assert.equal(result.claimsPermitted, false);
    assert.equal(result.excluded, true);
    assert.equal(result.pairCount, 20);
    assert.equal(result.totals.candidate.uncachedInput, 1600);
  }
});

test('P95 degrades strictly above 20%, with missing latency excluded', () => {
  const input = data();
  for (const pair of input.pairs) pair.candidate.latencyMs = 120;
  assert.equal(evaluate(input).claimsPermitted, true);
  for (const pair of input.pairs) pair.candidate.latencyMs = 121;
  assert.ok(evaluate(input).reasons.includes('p95-degradation'));
  input.pairs[0].candidate.latencyMs = null;
  assert.ok(evaluate(input).reasons.includes('missing-latency'));
});

test('five pairs screen only; validation requires twenty and heldout must be independent untuned', () => {
  const five = evaluate(data(5));
  assert.equal(five.stage, 'screening');
  assert.equal(five.claimsPermitted, false);
  assert.equal(evaluate(data(19)).claimsPermitted, false);
  for (const heldout of [undefined, { independent: false, untuned: true }, { independent: true, untuned: false }]) {
    const input = data(); input.heldout = heldout;
    assert.equal(evaluate(input).claimsPermitted, false);
  }
});

test('empty/zero baseline is N/A and equal vectors are not improvement', () => {
  const empty = evaluate({ pairs: [], expectedPairCount: 0 });
  assert.equal(empty.savingsRate, null); assert.equal(empty.vectorImprovement, null);
  const input = data();
  for (const pair of input.pairs) for (const arm of ['baseline', 'candidate']) pair[arm].requests[0].usage = Object.fromEntries(dimensions.map(k => [k, 0]));
  assert.equal(evaluate(input).vectorImprovement, null);
  assert.equal(evaluate(input).claimsPermitted, false);
  const equal = data(); for (const pair of equal.pairs) pair.candidate.requests[0].usage = usage(100);
  assert.equal(evaluate(equal).vectorImprovement, false);
});

test('24/48/72h gates remain pending without independently verified elapsed evidence', () => {
  const input = data();
  input.soakEvidence = [{ startedAt: 0, endedAt: 72 * 3600000, passed: true, evidenceRef: 'soak' }];
  assert.deepEqual(evaluate(input).soakGates, { 24: 'pending', 48: 'pending', 72: 'pending' });
  const result = evaluate(input, { ...trusted, now: 100 * 3600000, verifySoak: () => true });
  assert.deepEqual(result.soakGates, { 24: 'pass', 48: 'pass', 72: 'pass' });
  input.soakEvidence[0].endedAt = 30 * 3600000;
  assert.deepEqual(evaluate(input, { ...trusted, now: 100 * 3600000, verifySoak: () => true }).soakGates, { 24: 'pass', 48: 'pending', 72: 'pending' });
});

test('malformed evidence and duplicate pair IDs cannot authorize claims', () => {
  const input = data(); input.pairs[1].id = input.pairs[0].id;
  assert.equal(evaluate(input).claimsPermitted, false);
  assert.equal(evaluate(data(), { verifyEvidence: async () => true }).claimsPermitted, false);
  assert.equal(evaluate(data(), { verifyEvidence: () => { throw new Error('PRIVATE'); } }).claimsPermitted, false);
});

test('synthetic elapsed-hour fixtures cannot complete actual soak gates', () => {
  const input = data(); input.synthetic = true;
  input.soakEvidence = [{ startedAt: 0, endedAt: 72 * 3600000, passed: true, evidenceRef: 'fictional-soak' }];
  const result = evaluate(input, { ...trusted, now: 100 * 3600000, verifySoak: () => true });
  assert.deepEqual(result.soakGates, { 24: 'pending', 48: 'pending', 72: 'pending' });
});
