import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = resolve(repoRoot, 'scripts/release.mjs');

function runRelease(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('prints SDK release help', () => {
  const result = runRelease(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node scripts\/release\.mjs/);
  assert.match(result.stdout, /Release target: print-bridge-sdk/);
});

test('dry run prints SDK publish and tag commands', () => {
  const result = runRelease(['--', '--dry-run', '--skip-fetch']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Current package version: 0\.1\.2/);
  assert.match(result.stdout, /Release tag: v0\.1\.2/);
  assert.match(result.stdout, /Command: npm publish/);
  assert.match(result.stdout, /Command: git tag v0\.1\.2/);
  assert.match(result.stdout, /Dry run only/);
});
