import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverJsonlFilesRecursive } from '../src/util/file-discovery.js';

test('discoverJsonlFilesRecursive respects exclude patterns for path segments and relative paths', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-discovery-'));

  try {
    const includedDir = path.join(rootDir, 'project-a');
    const excludedSegmentDir = path.join(rootDir, 'project-a', 'vercel-plugin');
    const excludedRelativeDir = path.join(rootDir, 'nested', 'sessions');

    fs.mkdirSync(includedDir, { recursive: true });
    fs.mkdirSync(excludedSegmentDir, { recursive: true });
    fs.mkdirSync(excludedRelativeDir, { recursive: true });

    fs.writeFileSync(path.join(includedDir, 'session-a.jsonl'), '');
    fs.writeFileSync(path.join(excludedSegmentDir, 'skill-injections.jsonl'), '');
    fs.writeFileSync(path.join(excludedRelativeDir, 'fixture.jsonl'), '');

    const files = discoverJsonlFilesRecursive(rootDir, {
      excludePatterns: ['vercel-plugin', path.join('nested', 'sessions')],
    });

    assert.deepEqual(files, [path.join(includedDir, 'session-a.jsonl')]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
