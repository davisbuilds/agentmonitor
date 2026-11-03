import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfig } from '../src/config.js';

test('GitHub lookups are off unless asked for, and git reads run every ten minutes', () => {
  assert.deepEqual(createConfig({}, '/somewhere').git, { pollIntervalMs: 600_000, githubLookups: false });
  assert.equal(createConfig({ AGENTMONITOR_GITHUB_LOOKUPS: '1' }, '/somewhere').git.githubLookups, true);
  assert.equal(createConfig({ AGENTMONITOR_GIT_POLL_INTERVAL_MS: '0' }, '/somewhere').git.pollIntervalMs, 0);
});
