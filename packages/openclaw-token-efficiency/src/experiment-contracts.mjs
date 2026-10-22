/** Run untrusted candidate work with a bounded caller wait and handled late errors. */
async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('candidate-timeout')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
function validResult(result) {
  return result && typeof result.text === 'string' && Number.isSafeInteger(result.exitCode);
}
function sameResult(left, right) {
  return validResult(left) && validResult(right) && left.text === right.text && left.exitCode === right.exitCode;
}

/**
 * A fidelity/fallback adapter, NOT a compressor. Only generic shell results are
 * eligible. Candidate is one {name,kind,process}; process never reexecutes tools.
 * Recovery reads must recover stored raw results rather than rerun side effects.
 * Default audit deliberately excludes output, commands, paths, and exceptions.
 */
export async function executeWithOutputProcessor({
  execute, toolKind, exact = false, critical = false, candidate,
  requiredFacts = [], timeoutMs = 1000,
} = {}) {
  if (typeof execute !== 'function') throw new TypeError('execute is required');
  if (Array.isArray(candidate)) throw new TypeError('one processor is permitted');
  if (candidate && (typeof candidate !== 'object' || !['mock', 'actual-candidate'].includes(candidate.kind))) {
    throw new TypeError('candidate must explicitly identify mock or actual-candidate');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new TypeError('invalid candidate timeout');
  if (!Array.isArray(requiredFacts) || requiredFacts.some(fact => typeof fact !== 'string' || !fact.length)) throw new TypeError('invalid required facts');
  const original = await execute(); // Exactly one tool invocation; all fallback uses this value.
  const audit = {
    candidateStatus: candidate?.process ? candidate.kind : 'untested',
    changed: false, fallback: false, rawRecoveryVerified: false,
    originalChars: validResult(original) ? original.text.length : null,
    resultChars: validResult(original) ? original.text.length : null,
    reason: 'uninstalled-candidate',
  };
  const fallback = reason => ({ result: original, audit: { ...audit, fallback: true, reason } });
  if (exact || toolKind !== 'shell') return { result: original, audit: { ...audit, reason: 'unsupported-or-exact' } };
  if (!candidate?.process) return { result: original, audit };
  if (typeof candidate.process !== 'function' || !validResult(original)) return fallback('invalid-candidate-or-result');
  let processed;
  try {
    processed = await bounded(() => candidate.process(structuredClone(original)), timeoutMs);
  } catch { return fallback('candidate-error-or-timeout'); }
  if (!validResult(processed) || !processed.text.trim() || processed.exitCode !== original.exitCode ||
      requiredFacts.some(fact => !original.text.includes(fact) || !processed.text.includes(fact))) {
    return fallback('invalid-result-or-facts');
  }
  const changed = !sameResult(original, processed);
  if (critical && changed) {
    const recovery = processed.recovery;
    if (!recovery || typeof recovery.handle !== 'string' || !recovery.handle.length || recovery.handle.length > 1024 || typeof recovery.read !== 'function') {
      return fallback('raw-recovery-unverified');
    }
    try {
      if (!sameResult(original, await bounded(() => recovery.read(), timeoutMs))) return fallback('raw-recovery-unverified');
    } catch { return fallback('raw-recovery-unverified'); }
    audit.rawRecoveryVerified = true;
  }
  return { result: processed, audit: { ...audit, changed, resultChars: processed.text.length, reason: changed ? 'processed' : 'unchanged' } };
}

/** Pure lifecycle checks against supplied snapshots; no context/summary engine. */
export function validateHistoryContract({
  originalHistory, candidateHistory, engineOwners, originalEngine, selectedEngine,
  requirements = [], citations = [],
} = {}) {
  const reasons = [];
  if (!Array.isArray(engineOwners) || engineOwners.length !== 1 || engineOwners[0] !== selectedEngine ||
      typeof selectedEngine !== 'string' || !selectedEngine.length) reasons.push('one-context-engine-owner-required');
  if (selectedEngine !== originalEngine) reasons.push('engine-selection-changed');
  if (!Array.isArray(originalHistory) || !Array.isArray(candidateHistory)) reasons.push('history-snapshots-required');
  if (!Array.isArray(requirements) || !Array.isArray(citations) || [...(Array.isArray(requirements) ? requirements : []), ...(Array.isArray(citations) ? citations : [])].some(x => typeof x !== 'string' || !x.length)) {
    reasons.push('invalid-history-facts');
  }
  const pending = new Set(), completed = new Set();
  const text = [];
  for (const message of Array.isArray(candidateHistory) ? candidateHistory : []) {
    if (!message || typeof message !== 'object') { reasons.push('invalid-message'); continue; }
    if (typeof message.content === 'string') text.push(message.content);
    if (message.toolCalls !== undefined && !Array.isArray(message.toolCalls)) { reasons.push('invalid-tool-calls'); continue; }
    for (const call of message.toolCalls ?? []) {
      if (message.role !== 'assistant' || typeof call?.id !== 'string' || !call.id || pending.has(call.id) || completed.has(call.id)) {
        reasons.push('invalid-or-duplicate-tool-call');
      } else pending.add(call.id);
    }
    if (message.role === 'tool') {
      if (!pending.delete(message.toolCallId)) reasons.push('orphan-or-duplicate-tool-result');
      else completed.add(message.toolCallId);
    }
  }
  if (pending.size) reasons.push('incomplete-tool-pairs');
  const joined = text.join('\n');
  if (Array.isArray(requirements) && requirements.some(fact => !joined.includes(fact))) reasons.push('current-requirement-lost');
  if (Array.isArray(citations) && citations.some(fact => !joined.includes(fact))) reasons.push('source-citation-lost');
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], kind: 'contract-only' };
}

export function evaluateHistoryLifecycle({ fixtures = [] } = {}) {
  if (!Array.isArray(fixtures)) throw new TypeError('lifecycle fixtures must be an array');
  const stages = fixtures.map((fixture, index) => {
    const checked = validateHistoryContract(fixture);
    return { index, status: checked.valid ? 'contract-pass' : 'contract-fail', reasons: checked.reasons };
  });
  return {
    kind: 'contract-only', valid: fixtures.length > 0 && stages.every(stage => stage.status === 'contract-pass'), stages,
    actualCandidateTests: { T13: 'pending', T14: 'pending', T15: 'pending', T16: 'pending' },
    candidateLifecycleVerified: false,
  };
}
