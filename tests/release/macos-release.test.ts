import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = path.join(repoRoot, 'scripts', 'release', 'macos-release.sh');

function runPreflight(args: string[], envOverrides: Record<string, string> = {}) {
  const env = { ...process.env };
  delete env.APPLE_SIGNING_IDENTITY;
  delete env.APPLE_API_KEY;
  delete env.APPLE_API_ISSUER;
  delete env.APPLE_API_KEY_PATH;

  Object.assign(env, envOverrides);

  return spawnSync('bash', [scriptPath, ...args, '--dry-run'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

test('unsigned mode preflight passes with no signing env vars', () => {
  const result = runPreflight(['--mode', 'unsigned']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight passed/);
});

test('preflight tolerates pnpm argument separator token', () => {
  const result = runPreflight(['--', '--mode', 'unsigned']);
  assert.equal(result.status, 0, result.stderr);
});

test('signed mode preflight fails when APPLE_SIGNING_IDENTITY is missing', () => {
  const result = runPreflight(['--mode', 'signed']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APPLE_SIGNING_IDENTITY/);
});

test('signed mode preflight passes when APPLE_SIGNING_IDENTITY is set', () => {
  const result = runPreflight(['--mode', 'signed'], {
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example Corp (TEAMID1234)',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('signed-notarized mode preflight enforces API key file path', () => {
  const result = runPreflight(['--mode', 'signed-notarized'], {
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example Corp (TEAMID1234)',
    APPLE_API_KEY: 'ABC123XYZ',
    APPLE_API_ISSUER: '01234567-89ab-cdef-0123-456789abcdef',
    APPLE_API_KEY_PATH: '/tmp/agentmonitor-missing-api-key.p8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APPLE_API_KEY_PATH does not exist/);
});

test('signed-notarized mode preflight passes with full env', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-release-test-'));
  const keyPath = path.join(tempDir, 'AuthKey_TEST.p8');
  fs.writeFileSync(keyPath, 'dummy-private-key');

  const result = runPreflight(['--mode', 'signed-notarized'], {
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example Corp (TEAMID1234)',
    APPLE_API_KEY: 'ABC123XYZ',
    APPLE_API_ISSUER: '01234567-89ab-cdef-0123-456789abcdef',
    APPLE_API_KEY_PATH: keyPath,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight passed/);
});
