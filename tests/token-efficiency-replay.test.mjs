import test from 'node:test';
import assert from 'node:assert/strict';
import * as replay from '../scripts/token-efficiency-replay.mjs';

const call = (extra = {}) => ({ sessionId: 's', runId: 'r', tool: 'exec', args: { command: 'PRIVATE_COMMAND' },
  progress: { version: 1, status: 'failed' }, timestamp: 1, sideEffect: false, ...extra });
const series = (count, transform = () => ({})) => Array.from({ length: count }, (_, i) => call(transform(i)));
const runMock = calls => replay.replayToolCalls({ calls, adapter: replay.createMockDetectorAdapter({ threshold: 3 }) });

test('replay exposes explicit adapter API and defaults to not-tested', async () => {
  assert.equal(typeof replay.replayToolCalls, 'function');
  assert.equal(typeof replay.createMockDetectorAdapter, 'function');
  const result = await replay.replayToolCalls({ calls: series(4) });
  assert.equal(result.detectorKind, 'not-tested');
  assert.equal(result.modeledInvocations, null);
});

test('constant no-progress and changing timestamps exercise a labeled reference mock', async () => {
  for (const calls of [series(8), series(8, i => ({ timestamp: i * 1000 }))]) {
    const result = await runMock(calls);
    assert.equal(result.detectorKind, 'mock');
    assert.equal(result.modeledInvocations, 3);
    assert.equal(result.prevented, 5);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_COMMAND'));
  }
});

test('changing progress/version and legitimate failure then success do not falsely block', async () => {
  assert.equal((await runMock(series(8, i => ({ progress: { version: i, status: 'working' } })))).prevented, 0);
  const calls = series(2).concat(call({ progress: { version: 2, status: 'success' } }));
  assert.equal((await runMock(calls)).modeledInvocations, 3);
});

test('run and session boundaries get independent detector state', async () => {
  const calls = series(3).concat(series(3, () => ({ runId: 'r2' })), series(3, () => ({ sessionId: 's2' })));
  const result = await runMock(calls);
  assert.equal(result.prevented, 0);
  assert.equal(result.boundaries, 3);
});

test('non-idempotent writes are counted as modeled only and no side effects replay', async () => {
  let executions = 0;
  const result = await runMock(series(8, () => ({ sideEffect: true, execute: () => { executions++; } })));
  assert.equal(executions, 0);
  assert.equal(result.modeledWriteInvocations, 3);
  assert.equal(result.sideEffectsExecuted, 0);
});

test('actual-native is only an explicit injected adapter with evidence and fresh isolated state', async () => {
  let created = 0, inspected = 0, recorded = 0;
  const adapter = { kind: 'actual-native', evidenceRef: 'isolated-test-probe', create() {
    created++;
    return { inspect() { inspected++; return { blocked: false }; }, record() { recorded++; } };
  } };
  const calls = [call(), call({ runId: 'other' })];
  const result = await replay.replayToolCalls({ calls, adapter });
  assert.equal(result.detectorKind, 'actual-native');
  assert.equal(created, 2); assert.equal(inspected, 2); assert.equal(recorded, 2);
  assert.equal(result.evidenceRef, 'isolated-test-probe');
  // This verifies adapter plumbing; the fake adapter above is not host evidence.
  await assert.rejects(replay.replayToolCalls({ calls, adapter: { ...adapter, evidenceRef: undefined } }), /evidence/);
});

test('detector errors and ambiguous results are untested, never silently successful replay', async () => {
  for (const inspect of [() => { throw new Error('PRIVATE_ERROR'); }, () => ({})]) {
    const result = await replay.replayToolCalls({ calls: series(3), adapter: { kind: 'mock', create: () => ({ inspect, record() {} }) } });
    assert.equal(result.coverage, 'partial');
    assert.equal(result.errors, 3);
    assert.equal(result.modeledInvocations, 0);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_ERROR'));
  }
});
