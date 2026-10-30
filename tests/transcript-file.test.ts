import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { discoverCodexRolloutFilesRecursive } from '../src/util/file-discovery.js';
import { readTranscriptFile, transcriptBaseName } from '../src/util/transcript-file.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-transcript-file-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const rollout = (name: string) => `rollout-2026-03-0${name}T09-00-00-01990000-0000-7000-8000-00000000000${name}`;
const line = '{"type":"session_meta","payload":{"id":"x","cwd":"/work"}}\n';

test('a compressed rollout reads as its decompressed lines and keeps its session id', () => {
  const file = path.join(tempDir, `${rollout('1')}.jsonl.zst`);
  fs.writeFileSync(file, zstdCompressSync(Buffer.from(line)));
  assert.equal(readTranscriptFile(file).toString('utf8'), line);
  assert.equal(transcriptBaseName(file), rollout('1'));
  assert.equal(transcriptBaseName(path.join(tempDir, `${rollout('2')}.jsonl`)), rollout('2'));
});

test('discovery finds compressed rollouts, and one rollout once when both forms exist', () => {
  const dir = path.join(tempDir, 'sessions', '2026', '03');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rollout('3')}.jsonl.zst`), zstdCompressSync(Buffer.from(line)));
  fs.writeFileSync(path.join(dir, `${rollout('4')}.jsonl`), line);
  // Mid-compression both exist; the plain file is the one a live session appends to.
  fs.writeFileSync(path.join(dir, `${rollout('5')}.jsonl`), line);
  fs.writeFileSync(path.join(dir, `${rollout('5')}.jsonl.zst`), zstdCompressSync(Buffer.from(line)));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a rollout');
  assert.deepEqual(discoverCodexRolloutFilesRecursive(path.join(tempDir, 'sessions')).map(file => path.basename(file)), [
    `${rollout('3')}.jsonl.zst`, `${rollout('4')}.jsonl`, `${rollout('5')}.jsonl`,
  ]);
});
