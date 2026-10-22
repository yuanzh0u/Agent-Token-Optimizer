import { fingerprint } from './drift.mjs';

/**
 * Replay inert call/outcome fixtures through an explicit detector adapter.
 * Adapter create({sessionId,runId}) => {inspect(call),record(call)}. Inspection
 * must return {blocked:boolean}. Private/native functions belong in an optional
 * isolated adapter supplied by the operator, never this package's imports.
 */
export async function replayToolCalls({ calls = [], adapter } = {}) {
  if (!Array.isArray(calls)) throw new TypeError('replay calls must be an array');
  if (adapter && (!['actual-native', 'mock'].includes(adapter.kind) || typeof adapter.create !== 'function')) {
    throw new TypeError('explicit detector adapter required');
  }
  if (adapter?.kind === 'actual-native' && (typeof adapter.evidenceRef !== 'string' || !adapter.evidenceRef.length)) {
    throw new TypeError('native adapter evidence reference required');
  }
  const summary = {
    detectorKind: adapter?.kind ?? 'not-tested', evidenceRef: adapter?.evidenceRef ?? null,
    coverage: adapter ? 'complete-fixture-replay' : 'not-tested',
    fixtureCalls: calls.length, modeledInvocations: adapter ? 0 : null,
    modeledWriteInvocations: adapter ? 0 : null, prevented: 0, errors: 0,
    boundaries: 0, sideEffectsExecuted: 0,
  };
  if (!adapter) return summary;
  const states = new Map();
  for (const call of calls) {
    if (!call || typeof call.sessionId !== 'string' || !call.sessionId.length ||
        typeof call.runId !== 'string' || !call.runId.length || typeof call.tool !== 'string' || !call.tool.length) {
      throw new TypeError('replay requires explicit session, run and tool');
    }
    const boundary = JSON.stringify([call.sessionId, call.runId]);
    try {
      if (!states.has(boundary)) {
        const detector = await adapter.create({ sessionId: call.sessionId, runId: call.runId });
        if (typeof detector?.inspect !== 'function' || typeof detector?.record !== 'function') throw new TypeError('invalid detector instance');
        states.set(boundary, { detector, blocked: false });
        summary.boundaries++;
      }
      const state = states.get(boundary);
      if (state.blocked) { summary.prevented++; continue; }
      // Only inert fixture data is forwarded. Any execute function is discarded.
      const fixture = structuredClone({
        tool: call.tool, args: call.args ?? {}, progress: call.progress ?? null,
        timestamp: call.timestamp ?? null, outcome: call.outcome ?? null,
        sessionId: call.sessionId, runId: call.runId, sideEffect: call.sideEffect === true,
      });
      const verdict = await state.detector.inspect(fixture);
      if (typeof verdict?.blocked !== 'boolean') throw new TypeError('ambiguous detector result');
      if (verdict.blocked) {
        state.blocked = true;
        summary.prevented++;
      } else {
        summary.modeledInvocations++;
        if (call.sideEffect === true) summary.modeledWriteInvocations++;
        await state.detector.record(fixture);
      }
    } catch {
      summary.errors++;
      summary.coverage = 'partial';
    }
  }
  return summary;
}

/**
 * Deliberately simple REFERENCE MOCK, not native semantics or a production guard.
 * Timestamp-only differences are ignored; supplied progress changes reset it.
 */
export function createMockDetectorAdapter({ threshold = 3 } = {}) {
  if (!Number.isSafeInteger(threshold) || threshold <= 0) throw new TypeError('positive mock threshold required');
  return {
    kind: 'mock',
    create() {
      let previous = null, repeated = 0;
      const key = call => fingerprint({ tool: call.tool, args: call.args, progress: call.progress });
      return {
        inspect(call) { return { blocked: previous === key(call) && repeated >= threshold }; },
        record(call) {
          const current = key(call);
          repeated = previous === current ? repeated + 1 : 1;
          previous = current;
        },
      };
    },
  };
}
