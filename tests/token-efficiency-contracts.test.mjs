import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as contracts from '../packages/openclaw-token-efficiency/src/experiment-contracts.mjs';

const raw = { text: '\u001b[31mFAIL\u001b[0m 路径 /tmp/a b/file.js\n' + 'x'.repeat(5000) + '\n{"deep":{"inner":{"code":"E42"}}}', exitCode: 7 };
const facts = ['FAIL', '路径', '/tmp/a b/file.js', '"code":"E42"'];
const candidate = process => ({ name: 'fixture-only', kind: 'mock', process });
const run = extra => contracts.executeWithOutputProcessor({ execute: async () => raw, toolKind: 'shell', requiredFacts: facts, ...extra });

test('output contract API exists', () => {
  assert.equal(typeof contracts.executeWithOutputProcessor, 'function');
  assert.equal(typeof contracts.validateHistoryContract, 'function');
  assert.equal(typeof contracts.evaluateHistoryLifecycle, 'function');
});

test('uninstalled candidate remains untested and original command executes once', async () => {
  let executions = 0;
  const result = await run({ execute: async () => { executions++; return raw; } });
  assert.deepEqual(result.result, raw);
  assert.equal(result.audit.candidateStatus, 'untested');
  assert.equal(executions, 1);
  assert.ok(!JSON.stringify(result.audit).includes('/tmp/a b'));
});

test('exact file reads, JS, Code Mode and unsupported kinds pass through before processing', async () => {
  let processed = 0;
  for (const toolKind of ['read', 'javascript', 'code-mode', 'custom-tool']) {
    const result = await run({ toolKind, candidate: candidate(() => { processed++; throw new Error('should not run'); }) });
    assert.deepEqual(result.result, raw);
    assert.equal(result.audit.reason, 'unsupported-or-exact');
  }
  const result = await run({ exact: true, candidate: candidate(() => { processed++; }) });
  assert.deepEqual(result.result, raw);
  assert.equal(processed, 0);
});

test('one processor preserves Unicode, ANSI failure facts, deep JSON and exit status', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/token-efficiency/output/fidelity.json', import.meta.url)));
  for (const sample of fixture) {
    let calls = 0;
    const result = await contracts.executeWithOutputProcessor({
      execute: async () => sample.original, toolKind: 'shell', requiredFacts: sample.requiredFacts,
      candidate: candidate(original => { calls++; return structuredClone(original); }),
    });
    assert.deepEqual(result.result, sample.original);
    assert.equal(calls, 1);
    assert.equal(result.audit.candidateStatus, 'mock');
  }
  const shortened = { text: facts.join('\n'), exitCode: 7 };
  const result = await run({ candidate: candidate(() => shortened) });
  assert.deepEqual(result.result, shortened);
  assert.equal(result.audit.changed, true);
});

test('invalid, empty, missing facts, wrong exit and timed-out candidates fall back without rerun', async () => {
  for (const process of [
    () => { throw new Error('PRIVATE_ERROR'); },
    () => ({ text: '', exitCode: 7 }),
    () => ({ text: 'FAIL', exitCode: 7 }),
    () => ({ text: facts.join('\n'), exitCode: 0 }),
    () => null,
    original => { original.text = 'mutated'; return original; },
    () => new Promise(() => {}),
  ]) {
    let executions = 0;
    const result = await run({ execute: async () => { executions++; return structuredClone(raw); }, candidate: candidate(process), timeoutMs: 5 });
    assert.deepEqual(result.result, raw);
    assert.equal(result.audit.fallback, true);
    assert.equal(executions, 1);
    assert.ok(!JSON.stringify(result.audit).includes('PRIVATE_ERROR'));
  }
});

test('critical changes require a working raw reread handle, not just a claimed reference', async () => {
  for (const recovery of [undefined, { handle: 'fake' }, { handle: 'bad', read: async () => ({ text: 'wrong', exitCode: 7 }) }, { handle: 'stuck', read: () => new Promise(() => {}) }]) {
    const result = await run({ critical: true, candidate: candidate(() => ({ text: facts.join('\n'), exitCode: 7, recovery })), timeoutMs: 5 });
    assert.deepEqual(result.result, raw);
    assert.equal(result.audit.reason, 'raw-recovery-unverified');
  }
  let reads = 0, executions = 0;
  const result = await run({ critical: true, execute: async () => { executions++; return raw; }, candidate: candidate(() => ({
    text: facts.join('\n'), exitCode: 7, recovery: { handle: 'opaque-raw-ref', read: async () => { reads++; return raw; } },
  })) });
  assert.equal(result.audit.changed, true);
  assert.equal(result.audit.rawRecoveryVerified, true);
  assert.equal(executions, 1);
  assert.equal(reads, 1);
  assert.equal((await result.result.recovery.read()).text, raw.text);
});

test('multiple processors reject before executing side effects', async () => {
  let executed = false;
  await assert.rejects(run({ execute: async () => { executed = true; return raw; }, candidate: [candidate(() => raw), candidate(() => raw)] }), /one processor/);
  assert.equal(executed, false);
});

const history = [
  { role: 'user', content: 'CURRENT: keep all evidence [source:42]' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read' }] },
  { role: 'tool', toolCallId: 'c1', content: 'Evidence [source:42]' },
];
const historyFixture = extra => ({ originalHistory: history, candidateHistory: structuredClone(history),
  engineOwners: ['legacy'], originalEngine: 'legacy', selectedEngine: 'legacy',
  requirements: ['CURRENT: keep all evidence'], citations: ['[source:42]'], ...extra });

test('history validates one engine, complete tool pairs, current requirement and source citations without mutation', () => {
  const before = JSON.stringify(history);
  assert.equal(contracts.validateHistoryContract(historyFixture()).valid, true);
  for (const fixture of [
    historyFixture({ engineOwners: [] }), historyFixture({ engineOwners: ['legacy', 'lossless'] }),
    historyFixture({ selectedEngine: 'lossless' }),
    historyFixture({ candidateHistory: history.slice(0, 2) }),
    historyFixture({ candidateHistory: [history[2], history[0]] }),
    historyFixture({ candidateHistory: [history[0], history[1], history[2], history[2]] }),
    historyFixture({ candidateHistory: [{ role: 'user', content: '[source:42]' }] }),
    historyFixture({ candidateHistory: [{ role: 'user', content: 'CURRENT: keep all evidence' }] }),
  ]) assert.equal(contracts.validateHistoryContract(fixture).valid, false);
  assert.equal(JSON.stringify(history), before);
});

test('history lifecycle snapshots remain contract-only; Lossless T13–T16 stay pending', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/token-efficiency/history/lifecycle.json', import.meta.url)));
  const before = JSON.stringify(fixtures);
  const result = contracts.evaluateHistoryLifecycle({ fixtures });
  assert.equal(result.kind, 'contract-only');
  assert.equal(result.valid, true);
  assert.deepEqual(result.actualCandidateTests, { T13: 'pending', T14: 'pending', T15: 'pending', T16: 'pending' });
  assert.ok(result.stages.every(stage => stage.status === 'contract-pass'));
  assert.equal(JSON.stringify(fixtures), before);
});

test('candidate cannot manufacture a required fact missing from the original', async () => {
  const result = await run({ requiredFacts: [...facts, 'fabricated evidence'], candidate: candidate(() => ({ text: facts.join('\n') + '\nfabricated evidence', exitCode: 7 })) });
  assert.deepEqual(result.result, raw);
  assert.equal(result.audit.fallback, true);
});
