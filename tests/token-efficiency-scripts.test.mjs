import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const command = script => resolve('scripts', script);
const fixture = file => resolve('tests/fixtures/token-efficiency', file);

test('controller script runs only a clearly labeled fake-provider probe by default', async () => {
  const { stdout } = await exec(process.execPath, [command('token-efficiency-test-controller.mjs')]);
  const result = JSON.parse(stdout);
  assert.equal(result.kind, 'fake-provider-contract-probe');
  assert.equal(result.realModelCalls, 0);
  assert.equal(result.started, 4);
  assert.equal(result.hardTokenCap, false);
});

test('replay CLI explicitly labels absent and mock adapters', async () => {
  const args = [command('token-efficiency-replay.mjs'), fixture('replay.json')];
  const absent = JSON.parse((await exec(process.execPath, args)).stdout);
  assert.equal(absent.detectorKind, 'not-tested');
  const mock = JSON.parse((await exec(process.execPath, [...args, '--mock'])).stdout);
  assert.equal(mock.detectorKind, 'mock');
  assert.equal(mock.modeledInvocations, 3);
  assert.equal(mock.sideEffectsExecuted, 0);
});

test('evaluator CLI cannot promote synthetic token fixtures to measured savings', async () => {
  const result = JSON.parse((await exec(process.execPath, [command('token-efficiency-evaluate.mjs'), fixture('paired-synthetic.json')])).stdout);
  assert.equal(result.kind, 'synthetic-evaluation');
  assert.equal(result.stage, 'screening');
  assert.equal(result.claimsPermitted, false);
  assert.equal(result.savingsRate, null);
  assert.ok(result.reasons.includes('synthetic-results'));
});

test('CLI failures give content-free errors', async () => {
  for (const script of ['token-efficiency-replay.mjs', 'token-efficiency-evaluate.mjs']) {
    await assert.rejects(exec(process.execPath, [command(script)]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Usage:/);
      return true;
    });
  }
});
