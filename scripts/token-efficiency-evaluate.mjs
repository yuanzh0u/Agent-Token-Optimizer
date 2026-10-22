import { writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluatePairedResults } from '../packages/openclaw-token-efficiency/src/evaluate.mjs';
export { evaluatePairedResults };

// Default JSON-only evaluation cannot authenticate provider results. Only an
// explicit trusted local module may supply evidence verifiers; no model calls.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [inputPath, flag, evidencePath] = process.argv.slice(2);
    if (!inputPath || (flag && flag !== '--evidence-module') || (flag && !evidencePath)) throw new TypeError('usage');
    const input = JSON.parse(await readFile(inputPath, 'utf8'));
    const options = evidencePath ? await import(pathToFileURL(resolve(evidencePath)).href) : {};
    writeSync(1, JSON.stringify(evaluatePairedResults(input, options), null, 2) + '\n');
  } catch {
    writeSync(2, 'Evaluation failed. Usage: node scripts/token-efficiency-evaluate.mjs results.json [--evidence-module trusted-local.mjs]\n');
    process.exitCode = 1;
  }
}
