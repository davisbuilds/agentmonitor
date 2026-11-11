import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivacyProtectedPath } from '../src/util/privacy-protected.js';
import { runningAsLaunchdService } from '../src/util/service-context.js';

test('the folders macOS guards with a privacy prompt, and only those', () => {
  const home = '/Users/someone';
  for (const guarded of [
    '/Users/someone/Documents',
    '/Users/someone/Documents/Codex/task',
    '/Users/someone/Desktop/x',
    '/Users/someone/Downloads/repo',
    '/Users/someone/Library/Mobile Documents/iCloud~md~obsidian/Documents/vault',
    '/Users/someone/Library/CloudStorage/GoogleDrive/x',
    '/Volumes/External/repo',
  ]) assert.equal(isPrivacyProtectedPath(guarded, home), true, guarded);
  for (const open of [
    '/Users/someone/Dev/agentmonitor',
    '/Users/someone/DocumentsArchive/x',
    '/Users/someone/Library/Application Support/x',
    '/Users/example/Documents/x',
    '/tmp/scratch',
  ]) assert.equal(isPrivacyProtectedPath(open, home), false, open);
});

test('the launchd service is recognized by the job name launchd gives it', () => {
  assert.equal(runningAsLaunchdService({ XPC_SERVICE_NAME: 'dev.agentmonitor.serve' }), true);
  assert.equal(runningAsLaunchdService({ XPC_SERVICE_NAME: 'application.com.mitchellh.ghostty.1234' }), false);
  assert.equal(runningAsLaunchdService({}), false);
});
