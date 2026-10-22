import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import * as controllerModule from '../scripts/token-efficiency-test-controller.mjs';

const mapping = {
  fields: { input: 'usage.input', output: 'usage.output', cacheRead: 'usage.read', cacheWrite: 'usage.write' },
  inputIncludesCacheRead: false, inputIncludesCacheWrite: false,
};
const result = (input = 3) => ({ text: 'SECRET_BODY', usage: { input, output: 2, read: 0, write: 0 } });
const make = options => controllerModule.createTestController({ usageMapping: mapping, ...options });

test('controller exposes the injected-provider contract', () => {
  assert.equal(typeof controllerModule.createTestController, 'function');
});

test('every explicitly routed primary, retry, summary and retrieval reserves and measures', async () => {
  const received = [];
  const gate = make({ provider: async (input, options) => { received.push(options.maxOutputTokens); return result(); } });
  for (const purpose of ['primary', 'retry', 'summary', 'retrieval']) {
    await gate.request('PRIVATE_PROMPT', { estimatedInputTokens: 5, purpose });
  }
  const report = gate.report();
  assert.equal(report.started, 4);
  assert.equal(report.estimatedInputTokens, 20);
  assert.equal(report.measured.uncachedInput, 12);
  assert.deepEqual(received, [1024, 1024, 1024, 1024]);
  assert.equal(report.hardTokenCap, false);
  assert.equal(report.coverage, 'injected-paths-only');
  assert.ok(!JSON.stringify(report).includes('SECRET_BODY'));
  assert.ok(!JSON.stringify(report).includes('PRIVATE_PROMPT'));
  gate.cancel();
});

test('invalid or unknown estimates never start a provider request', async () => {
  let calls = 0;
  const gate = make({ provider: async () => { calls++; return result(); } });
  for (const estimatedInputTokens of [undefined, null, NaN, Infinity, -1, 1.2, '10']) {
    await assert.rejects(gate.request({}, { estimatedInputTokens }), /estimate/i);
  }
  assert.equal(calls, 0);
  gate.cancel();
});

test('atomic concurrency and reservations stop all new work at the first limit', async () => {
  let active = 0, peak = 0, calls = 0;
  const gate = make({ limits: { concurrency: 2, maxRequests: 3, estimatedInputTokens: 9 }, provider: async () => {
    calls++; peak = Math.max(peak, ++active); await delay(8); active--; return result();
  } });
  const jobs = Array.from({ length: 5 }, () => gate.request({}, { estimatedInputTokens: 3 }));
  const settled = await Promise.allSettled(jobs);
  assert.ok(peak <= 2);
  assert.equal(calls, 3);
  assert.ok(settled.some(x => x.status === 'rejected'));
  assert.equal(gate.report().started, 3);
  await assert.rejects(gate.request({}, { estimatedInputTokens: 0 }), /limit/);
  await gate.drain({ timeoutMs: 100 });
});

test('estimated limit cannot be bypassed by queuing and actual overshoot is reported', async () => {
  const gate = make({ limits: { estimatedInputTokens: 5 }, provider: async () => result(12) });
  await gate.request({}, { estimatedInputTokens: 5 });
  await assert.rejects(gate.request({}, { estimatedInputTokens: 1 }), /limit/);
  const report = gate.report();
  assert.equal(report.inputEstimateOvershoot, 7);
  assert.equal(report.inputBudgetOvershoot, 7);
  assert.equal(report.measured.output, 2);
});

test('streaming is observed to settlement without retaining chunks', async () => {
  const chunks = [];
  const gate = make({ provider: async function* () {
    yield { text: 'SECRET_STREAM', usage: { input: 4, output: 1, read: 0, write: 0 } };
    yield { text: 'FINAL', usage: { input: 4, output: 3, read: 0, write: 0 } };
  } });
  const final = await gate.request({}, { estimatedInputTokens: 4, onChunk: chunk => chunks.push(chunk.text) });
  assert.equal(final.text, 'FINAL');
  assert.deepEqual(chunks, ['SECRET_STREAM', 'FINAL']);
  assert.equal(gate.report().measured.output, 3);
  assert.ok(!JSON.stringify(gate.report()).includes('SECRET_STREAM'));
  gate.cancel();
});

test('cancel returns promptly but a provider ignoring abort settles as billable later', async () => {
  let settle;
  const gate = make({ provider: () => new Promise(resolve => { settle = resolve; }) });
  const request = gate.request({}, { estimatedInputTokens: 3 });
  await delay(0);
  gate.cancel();
  await assert.rejects(request, /cancel/);
  await assert.rejects(gate.request({}, { estimatedInputTokens: 1 }), /cancel/);
  assert.equal((await gate.drain({ timeoutMs: 5 })).pending, 1);
  settle(result(8));
  assert.equal((await gate.drain({ timeoutMs: 100 })).pending, 0);
  assert.equal(gate.report().measured.uncachedInput, 8);
  assert.equal(gate.report().lateSettlements, 1);
  assert.deepEqual(gate.report().trace.map(x => x.event), ['start', 'cancel', 'end']);
});

test('deadline and per-request abort stop queued work even if provider never settles', async () => {
  const gate = make({ limits: { wallTimeMs: 12 }, provider: () => new Promise(() => {}) });
  const results = await Promise.allSettled([
    gate.request({}, { estimatedInputTokens: 1 }), gate.request({}, { estimatedInputTokens: 1 }),
  ]);
  assert.ok(results.every(x => x.status === 'rejected'));
  assert.equal(gate.report().started, 1);
  assert.match(gate.report().stopReason, /deadline/);
  assert.equal((await gate.drain({ timeoutMs: 3 })).pending, 1);
  const abort = new AbortController();
  const other = make({ provider: () => new Promise(() => {}) });
  const pending = other.request({}, { estimatedInputTokens: 1, signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /cancel/);
  await assert.rejects(other.request({}, { estimatedInputTokens: 1 }), /cancel/);
});

test('failed calls with usage remain counted; late rejection does not become unhandled', async () => {
  const gate = make({ provider: async () => { throw Object.assign(new Error('PRIVATE_ERROR'), result(6)); } });
  await assert.rejects(gate.request({}, { estimatedInputTokens: 3 }));
  assert.equal(gate.report().failed, 1);
  assert.equal(gate.report().measured.uncachedInput, 6);
  assert.ok(!JSON.stringify(gate.report()).includes('PRIVATE_ERROR'));
  gate.cancel();
  let reject;
  const other = make({ provider: () => new Promise((resolve, rej) => { reject = rej; }) });
  const pending = other.request({}, { estimatedInputTokens: 1 });
  await delay(0); other.cancel(); await assert.rejects(pending);
  reject(new Error('late private failure'));
  await other.drain({ timeoutMs: 100 });
  assert.equal(other.report().failed, 1);
});

test('missing and invalid usage stay unknown; unsupported paths stay explicitly partial', async () => {
  const gate = make({ externalPaths: ['external-cli'], provider: async () => ({ text: 'no usage' }) });
  await gate.request({}, { estimatedInputTokens: 1 });
  assert.equal(gate.report().measured.uncachedInput, null);
  assert.equal(gate.report().usageComplete, false);
  assert.deepEqual(gate.report().unsupportedPaths, ['external-cli']);
  gate.cancel();
});

test('drain waits for queued work as well as the first active batch', async () => {
  const gate = make({ provider: async () => { await delay(4); return result(); } });
  const jobs = Array.from({ length: 3 }, () => gate.request({}, { estimatedInputTokens: 1 }));
  assert.deepEqual(await gate.drain({ timeoutMs: 100 }), { pending: 0, queued: 0 });
  await Promise.all(jobs);
  gate.cancel();
});

test('aggregate input overflow stays unknown instead of reporting unsafe arithmetic', async () => {
  const gate = make({ provider: async () => ({ usage: { input: Number.MAX_SAFE_INTEGER, output: 1, read: Number.MAX_SAFE_INTEGER, write: 0 } }) });
  await gate.request({}, { estimatedInputTokens: 1 });
  assert.equal(gate.report().inputEstimateOvershoot, null);
  gate.cancel();
});

for (const delivery of ['throw', 'reject']) {
  test(`a ${delivery}ing chunk callback does not settle or release the provider stream`, async () => {
    let starts = 0, deliveries = 0, remoteFinished = false, iteratorClosedEarly = false;
    const gate = make({ provider: async function* () {
      starts++;
      if (starts === 1) {
        // This remote timer keeps running even if iterator.return() closes the
        // local generator. Delivery failure must not invoke that early closure.
        const remote = delay(20).then(() => {
          remoteFinished = true;
          return { usage: { input: 4, output: 30, read: 0, write: 0 } };
        });
        try {
          yield { usage: { input: 4, output: 1, read: 0, write: 0 } };
          yield await remote;
        } finally { iteratorClosedEarly = !remoteFinished; }
      } else {
        assert.equal(remoteFinished, true, 'second request started before first remote settlement');
        yield { usage: { input: 4, output: 0, read: 0, write: 0 } };
      }
    } });
    try {
      const first = gate.request({}, { estimatedInputTokens: 4, onChunk() {
        deliveries++;
        if (delivery === 'throw') throw new Error('PRIVATE_DELIVERY_FAILURE');
        return Promise.reject(new Error('PRIVATE_DELIVERY_FAILURE'));
      } });
      await assert.rejects(first, /PRIVATE_DELIVERY_FAILURE/);
      assert.equal(remoteFinished, false);
      assert.equal(gate.report().pending, 1);
      assert.equal(gate.report().settled, 0);
      assert.equal(gate.report().usageComplete, false);
      assert.equal(gate.report().measured.output, null);
      const second = gate.request({}, { estimatedInputTokens: 4 });
      assert.equal(starts, 1);
      assert.equal(gate.report().queued, 1);
      await second;
      assert.deepEqual(await gate.drain({ timeoutMs: 100 }), { pending: 0, queued: 0 });
      assert.equal(iteratorClosedEarly, false);
      assert.equal(deliveries, 1);
      assert.equal(gate.report().measured.output, 30);
      assert.equal(gate.report().usageComplete, true);
      assert.equal(gate.report().failed, 1);
      assert.equal(gate.report().lateSettlements, 1);
      assert.ok(!JSON.stringify(gate.report()).includes('PRIVATE_DELIVERY_FAILURE'));
    } finally { gate.cancel(); }
  });
}

test('a provider stream error cannot turn an interim snapshot into complete usage', async () => {
  const gate = make({ provider: async function* () {
    yield { usage: { input: 4, output: 1, read: 0, write: 0 } };
    throw new Error('PRIVATE_TRANSPORT_FAILURE');
  } });
  try {
    await assert.rejects(gate.request({}, { estimatedInputTokens: 4 }), /PRIVATE_TRANSPORT_FAILURE/);
    assert.equal(gate.report().settled, 1);
    assert.equal(gate.report().usageComplete, false);
    assert.equal(gate.report().measured.output, null);
    assert.equal(gate.report().knownMeasured.output, 1);
    assert.ok(!JSON.stringify(gate.report()).includes('PRIVATE_TRANSPORT_FAILURE'));
  } finally { gate.cancel(); }
});

test('an aborted stream that ends normally still has explicitly incomplete usage', async () => {
  let firstChunk;
  const delivered = new Promise(resolve => { firstChunk = resolve; });
  const gate = make({ provider: async function* (input, { signal }) {
    yield { usage: { input: 4, output: 1, read: 0, write: 0 } };
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    // A transport may end locally on abort while its remote request continues.
  } });
  const pending = gate.request({}, { estimatedInputTokens: 4, onChunk: () => firstChunk() });
  const rejection = assert.rejects(pending, /cancel/);
  await delivered;
  gate.cancel();
  await rejection;
  assert.equal((await gate.drain({ timeoutMs: 100 })).pending, 0);
  assert.equal(gate.report().knownMeasured.output, 1);
  assert.equal(gate.report().measured.output, null);
  assert.equal(gate.report().usageComplete, false);
});

test('an aborted stream is still drained and its later cumulative usage remains observed', async () => {
  let firstChunk, deliveries = 0;
  const delivered = new Promise(resolve => { firstChunk = resolve; });
  const gate = make({ provider: async function* () {
    yield { usage: { input: 4, output: 1, read: 0, write: 0 } };
    await delay(20);
    yield { usage: { input: 4, output: 30, read: 0, write: 0 } };
  } });
  const pending = gate.request({}, { estimatedInputTokens: 4, onChunk: () => { deliveries++; firstChunk(); } });
  const rejection = assert.rejects(pending, /cancel/);
  await delivered;
  gate.cancel();
  await rejection;
  assert.equal(gate.report().pending, 1);
  assert.equal(gate.report().usageComplete, false);
  assert.equal((await gate.drain({ timeoutMs: 100 })).pending, 0);
  assert.equal(deliveries, 1);
  assert.equal(gate.report().knownMeasured.output, 30);
  assert.equal(gate.report().measured.output, null);
  assert.equal(gate.report().usageComplete, false);
});
