import { writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayToolCalls, createMockDetectorAdapter } from '../packages/openclaw-token-efficiency/src/replay.mjs';
export { replayToolCalls, createMockDetectorAdapter };

// No host import by default. An explicit adapter module executes trusted local
// code; it must export `adapter`. JSON fixtures can never select a module.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [fixturePath, adapterFlag, adapterPath] = process.argv.slice(2);
    if (!fixturePath || (adapterFlag && !['--mock', '--adapter'].includes(adapterFlag)) || (adapterFlag === '--adapter' && !adapterPath)) {
      throw new TypeError('usage');
    }
    const input = JSON.parse(await readFile(fixturePath, 'utf8'));
    const adapter = adapterFlag === '--mock' ? createMockDetectorAdapter()
      : adapterFlag === '--adapter' ? (await import(pathToFileURL(resolve(adapterPath)).href)).adapter : undefined;
    writeSync(1, JSON.stringify(await replayToolCalls({ calls: input.calls, adapter }), null, 2) + '\n');
  } catch {
    writeSync(2, 'Replay failed. Usage: node scripts/token-efficiency-replay.mjs fixture.json [--mock | --adapter local-module.mjs]\n');
    process.exitCode = 1;
  }
}
