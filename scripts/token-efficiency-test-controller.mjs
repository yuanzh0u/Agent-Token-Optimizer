import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestController } from '../packages/openclaw-token-efficiency/src/test-controller.mjs';
export { createTestController, DEFAULT_TEST_LIMITS } from '../packages/openclaw-token-efficiency/src/test-controller.mjs';

// Executing this file runs only an offline fake. There is no real-provider flag.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const gate = createTestController({
    provider: async () => ({ usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0 } }),
    usageMapping: {
      fields: { input: 'usage.input', output: 'usage.output', cacheRead: 'usage.cacheRead', cacheWrite: 'usage.cacheWrite' },
      inputIncludesCacheRead: false, inputIncludesCacheWrite: false,
    },
  });
  try {
    for (const purpose of ['primary', 'retry', 'summary', 'retrieval']) {
      await gate.request({}, { purpose, estimatedInputTokens: 10 });
    }
    writeSync(1, JSON.stringify({ ...gate.report(), kind: 'fake-provider-contract-probe', realModelCalls: 0 }, null, 2) + '\n');
  } finally { gate.cancel(); }
}
