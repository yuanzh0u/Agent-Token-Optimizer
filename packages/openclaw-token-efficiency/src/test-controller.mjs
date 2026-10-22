import { DIMENSIONS, normalizeUsage, tokenCount } from './usage.mjs';

export const DEFAULT_TEST_LIMITS = Object.freeze({
  concurrency: 1,
  maxRequests: 20,
  estimatedInputTokens: 500000,
  perRequestMaxOutputTokens: 1024,
  wallTimeMs: 600000,
});
const PURPOSES = new Set(['primary', 'retry', 'summary', 'retrieval', 'fallback']);
const emptyVector = value => Object.fromEntries(DIMENSIONS.map(key => [key, value]));

/**
 * Inject ALL provider paths through request(), including retry/summary/retrieval.
 * Provider receives {signal,maxOutputTokens}; its adapter must honor that output
 * limit. Streams use cumulative usage snapshots and optional onChunk delivery.
 * Cancellation bounds the caller's wait, not the remote bill or provider lifetime.
 */
export function createTestController({ provider, usageMapping, limits = {}, externalPaths = [] } = {}) {
  if (typeof provider !== 'function') throw new TypeError('provider function required');
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(DEFAULT_TEST_LIMITS, key)) throw new TypeError('unknown test limit');
  }
  const budget = { ...DEFAULT_TEST_LIMITS, ...limits };
  for (const [key, value] of Object.entries(budget)) {
    if (tokenCount(value, key) === null || value <= 0) throw new TypeError('positive test limits required');
  }
  if (budget.wallTimeMs > 2147483647) throw new TypeError('wall time exceeds timer range');
  if (!Array.isArray(externalPaths) || externalPaths.some(x => typeof x !== 'string' || x.length > 128)) {
    throw new TypeError('external path names required');
  }
  const abort = new AbortController();
  const startedAt = Date.now();
  const queue = [], trace = [], records = [], idleWaiters = new Set();
  let active = 0, estimated = 0, stopReason = null;
  let pumping = false;
  const deadlineTimer = setTimeout(() => stop('deadline'), budget.wallTimeMs);
  deadlineTimer.unref();

  function stop(reason) {
    if (stopReason) return;
    stopReason = reason;
    clearTimeout(deadlineTimer);
    trace.push({ event: 'cancel', reason, elapsedMs: Date.now() - startedAt });
    abort.abort(new Error(reason));
    for (const job of queue.splice(0)) job.reject(new Error(reason));
    for (const record of records) record.reject?.(new Error(reason));
    if (active === 0) for (const resolve of idleWaiters) resolve();
  }

  function observe(raw, record) {
    if (!usageMapping) return;
    try {
      const usage = normalizeUsage(raw, usageMapping);
      // Non-usage stream chunks must not erase an earlier cumulative snapshot.
      if (DIMENSIONS.some(key => usage[key] !== null)) {
        record.usage = Object.fromEntries(DIMENSIONS.map(key => [key, usage[key]]));
      }
    } catch {
      record.invalidUsage = true;
      record.usage = emptyVector(null);
    }
  }

  async function run(job, record) {
    let failed = false, streaming = false, deliveryFailed = false;
    try {
      let value = await provider(job.input, {
        signal: abort.signal,
        maxOutputTokens: budget.perRequestMaxOutputTokens,
        purpose: job.purpose,
      });
      if (value?.[Symbol.asyncIterator]) {
        streaming = true;
        let final;
        for await (const chunk of value) {
          observe(chunk, record);
          final = chunk;
          if (job.onChunk && !deliveryFailed && !stopReason) {
            try { await job.onChunk(chunk); }
            catch (error) {
              // A delivery consumer is not the provider. Reject its caller but
              // retain the slot and continue observing the remote stream.
              deliveryFailed = true;
              failed = true;
              job.reject(error);
            }
          }
        }
        // Local stream exhaustion after abort does not prove remote billing
        // ended. Keep observed snapshots as partial, never authoritative usage.
        record.incompleteUsage = stopReason !== null;
        value = final;
      } else {
        observe(value, record);
      }
      job.resolve(value);
    } catch (error) {
      failed = true;
      if (streaming) record.incompleteUsage = true;
      observe(error, record);
      job.reject(error);
    } finally {
      record.settled = true;
      record.failed = failed;
      record.late = stopReason !== null || deliveryFailed;
      delete record.reject;
      job.cleanup();
      active--;
      trace.push({ event: 'end', id: record.id, failed, late: record.late, elapsedMs: Date.now() - startedAt });
      if (active === 0) deadlineTimer.unref();
      pump();
      if (active === 0 && queue.length === 0) for (const resolve of idleWaiters) resolve();
    }
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && active < budget.concurrency && !stopReason) {
        if (Date.now() - startedAt >= budget.wallTimeMs) { stop('deadline'); break; }
        const job = queue[0];
        if (records.length >= budget.maxRequests || job.estimate > budget.estimatedInputTokens - estimated) {
          stop('limit'); break;
        }
        queue.shift();
        // Reservation is synchronous and complete before calling provider code.
        estimated += job.estimate;
        active++;
        deadlineTimer.ref();
        const record = {
          id: records.length + 1, purpose: job.purpose, estimate: job.estimate,
          usage: emptyVector(null), settled: false, reject: job.reject,
        };
        records.push(record);
        trace.push({ event: 'start', id: record.id, purpose: job.purpose, estimate: job.estimate, elapsedMs: Date.now() - startedAt });
        // run handles provider rejection; retain no request body in an audit.
        void run(job, record);
      }
    } finally { pumping = false; }
  }

  async function request(input, { estimatedInputTokens: estimate, purpose = 'primary', signal, onChunk } = {}) {
    if (tokenCount(estimate, 'estimate') === null) throw new TypeError('estimate is required');
    if (!PURPOSES.has(purpose)) throw new TypeError('unsupported request purpose');
    if (onChunk !== undefined && typeof onChunk !== 'function') throw new TypeError('onChunk must be a function');
    if (signal?.aborted) stop('cancel');
    if (Date.now() - startedAt >= budget.wallTimeMs) stop('deadline');
    if (stopReason) throw new Error(stopReason);
    return new Promise((resolve, reject) => {
      const cancelled = () => stop('cancel');
      const cleanup = () => signal?.removeEventListener('abort', cancelled);
      signal?.addEventListener('abort', cancelled, { once: true });
      queue.push({ input, estimate, purpose, onChunk, resolve, reject: error => { cleanup(); reject(error); }, cleanup });
      pump();
    });
  }

  function report() {
    const settled = records.filter(record => record.settled);
    const knownMeasured = emptyVector(0), knownCounts = emptyVector(0);
    for (const record of settled) {
      for (const key of DIMENSIONS) {
        const value = record.invalidUsage ? null : record.usage[key];
        if (value !== null && Number.isSafeInteger(knownMeasured[key] + value)) {
          knownMeasured[key] += value;
          knownCounts[key]++;
        }
      }
    }
    const completeSettlement = records.every(record => record.settled && !record.incompleteUsage);
    const measured = Object.fromEntries(DIMENSIONS.map(key => [
      key, records.length > 0 && completeSettlement && knownCounts[key] === records.length ? knownMeasured[key] : null,
    ]));
    const inputSum = ['uncachedInput', 'cacheRead', 'cacheWrite'].every(key => measured[key] !== null)
      ? measured.uncachedInput + measured.cacheRead + measured.cacheWrite : null;
    const input = Number.isSafeInteger(inputSum) ? inputSum : null;
    return {
      kind: 'controlled-test', coverage: 'injected-paths-only', hardTokenCap: false,
      unsupportedPaths: [...externalPaths], limits: { ...budget },
      started: records.length, settled: settled.length, pending: active, queued: queue.length,
      failed: settled.filter(record => record.failed).length,
      lateSettlements: settled.filter(record => record.late).length,
      stopReason, estimatedInputTokens: estimated, measured, knownMeasured, knownCounts,
      usageComplete: records.length > 0 && DIMENSIONS.every(key => measured[key] !== null),
      inputEstimateOvershoot: input === null ? null : Math.max(0, input - estimated),
      inputBudgetOvershoot: input === null ? null : Math.max(0, input - budget.estimatedInputTokens),
      outputLimitOvershoot: settled.some(record => record.usage.output > budget.perRequestMaxOutputTokens),
      trace: trace.map(event => ({ ...event })),
    };
  }

  async function drain({ timeoutMs = 1000 } = {}) {
    if (tokenCount(timeoutMs, 'drain timeout') === null || timeoutMs > 2147483647) throw new TypeError('invalid drain timeout');
    if (active === 0 && queue.length === 0) return { pending: 0, queued: 0 };
    let timer, idle;
    try {
      await Promise.race([
        new Promise(resolve => { idle = resolve; idleWaiters.add(resolve); }),
        new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      idleWaiters.delete(idle);
    }
    return { pending: active, queued: queue.length };
  }
  return { request, report, cancel: () => stop('cancel'), drain };
}
