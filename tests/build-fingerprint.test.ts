import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after, beforeEach, describe } from 'node:test';

import { buildFingerprint, createBuildWatch, runningBuildRoot, serverBuildStatus, startServerBuildWatch } from '../src/build-fingerprint.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-build-fingerprint-'));
const dist = path.join(tempDir, 'dist');

function write(relative: string, content: string): void {
  const file = path.join(dist, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
  write('server.js', 'export const a = 1;');
  write('import/codex.js', 'export const b = 2;');
  write('pricing/data/codex.json', '{"gpt":1}');
  write('server.js.map', '{}');
  write('server.d.ts', 'export declare const a: number;');
});

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe('build fingerprint', () => {
  test('changes when any compiled module changes, however deep', () => {
    const before = buildFingerprint(dist);
    write('import/codex.js', 'export const b = 3;');
    assert.notEqual(buildFingerprint(dist), before);
  });

  test('changes when the pricing tables change', () => {
    const before = buildFingerprint(dist);
    write('pricing/data/codex.json', '{"gpt":2}');
    assert.notEqual(buildFingerprint(dist), before);
  });

  test('is unchanged when the same build is written again', () => {
    const before = buildFingerprint(dist);
    write('server.js', 'export const a = 1;');
    assert.equal(buildFingerprint(dist), before);
  });

  test('ignores files the server never loads', () => {
    const before = buildFingerprint(dist);
    write('server.js.map', '{"changed":true}');
    write('server.d.ts', 'export declare const a: string;');
    assert.equal(buildFingerprint(dist), before);
  });

  test('changes when a module is added or removed', () => {
    const before = buildFingerprint(dist);
    write('extra.js', '');
    const added = buildFingerprint(dist);
    assert.notEqual(added, before);
    fs.rmSync(path.join(dist, 'extra.js'));
    assert.equal(buildFingerprint(dist), before);
  });
});

describe('build watch', () => {
  test('reports a rebuild after start as stale', () => {
    const watch = createBuildWatch(dist);
    assert.deepEqual([watch.status().tracked, watch.status().stale], [true, false]);
    write('import/codex.js', 'export const b = 4;');
    const status = watch.status();
    assert.equal(status.stale, true);
    assert.equal(status.started, watch.started);
    assert.notEqual(status.current, status.started);
  });

  test('is untracked when the process runs from source', () => {
    const status = createBuildWatch(null).status();
    assert.deepEqual([status.tracked, status.stale], [false, false]);
  });

  test('knows a dist module from a source one', () => {
    assert.equal(runningBuildRoot(pathToFileURL(path.join(dist, 'build-fingerprint.js')).href), dist);
    assert.equal(runningBuildRoot(pathToFileURL(path.join(tempDir, 'src', 'build-fingerprint.ts')).href), null);
  });
});

test('the server reports the build it started with going stale', () => {
  const started = startServerBuildWatch(dist);
  assert.equal(serverBuildStatus().stale, false);
  write('server.js', 'export const a = 99;');
  const status = serverBuildStatus();
  assert.deepEqual([status.tracked, status.stale, status.started], [true, true, started]);
  startServerBuildWatch(null);
  assert.equal(serverBuildStatus().tracked, false);
});
