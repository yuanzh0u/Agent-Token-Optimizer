import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../packages/openclaw-token-efficiency/src/index.mjs';

test('portable experiment interfaces are exported by root and declared subpaths', async () => {
  for (const name of ['createTestController', 'executeWithOutputProcessor', 'validateHistoryContract', 'evaluateHistoryLifecycle', 'replayToolCalls', 'createMockDetectorAdapter', 'evaluatePairedResults']) {
    assert.equal(typeof core[name], 'function', name);
  }
  const manifest = JSON.parse(await readFile(new URL('../packages/openclaw-token-efficiency/package.json', import.meta.url)));
  for (const module of ['test-controller', 'experiment-contracts', 'replay', 'evaluate']) {
    assert.equal(manifest.exports[`./${module}`], `./src/${module}.mjs`);
  }
});
