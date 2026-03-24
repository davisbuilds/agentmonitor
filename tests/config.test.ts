import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('createConfig derives projectsDir from repository ancestry when unset', () => {
  const cwd = path.join(repoRoot, 'src');
  const config = createConfig({}, cwd);

  assert.equal(config.projectsDir, path.dirname(repoRoot));
});

test('createConfig falls back to cwd when repository cannot be detected', () => {
  const cwd = path.join('/tmp', 'agentmonitor-config-test-workdir');
  const config = createConfig({}, cwd);

  assert.equal(config.projectsDir, cwd);
});

test('createConfig resolves AGENTMONITOR_PROJECTS_DIR relative to cwd', () => {
  const cwd = path.join(repoRoot, 'dist');
  const config = createConfig({ AGENTMONITOR_PROJECTS_DIR: '../workspace' }, cwd);

  assert.equal(config.projectsDir, path.resolve(cwd, '../workspace'));
});

test('createConfig parses live tab and privacy settings', () => {
  const config = createConfig({
    AGENTMONITOR_ENABLE_LIVE_TAB: 'false',
    AGENTMONITOR_CODEX_LIVE_MODE: 'exporter',
    AGENTMONITOR_LIVE_CAPTURE_PROMPTS: '0',
    AGENTMONITOR_LIVE_CAPTURE_REASONING: 'no',
    AGENTMONITOR_LIVE_CAPTURE_TOOL_ARGUMENTS: 'off',
    AGENTMONITOR_LIVE_DIFF_PAYLOAD_MAX_BYTES: '4096',
  }, repoRoot);

  assert.equal(config.live.enabled, false);
  assert.equal(config.live.codexMode, 'exporter');
  assert.equal(config.live.capture.prompts, false);
  assert.equal(config.live.capture.reasoning, false);
  assert.equal(config.live.capture.toolArguments, false);
  assert.equal(config.live.diffPayloadMaxBytes, 4096);
});
