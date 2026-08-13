import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import Database from 'better-sqlite3';
import { main } from '../src/cli.js';

class CaptureStream extends Writable {
  output = '';

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

async function runCli(args: string[]) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const result = await main(['/usr/local/bin/node', '/repo/dist/cli.js', ...args], { stdout, stderr });
  return { ...result, stdout: stdout.output, stderr: stderr.output };
}

interface Fixture {
  root: string;
  source: string;
  outputDir: string;
  output: string;
  writer: Database.Database;
}

function newFixture(name: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentmonitor-database-backup-${name}-`));
  const source = path.join(root, 'live.db');
  const outputDir = path.join(root, 'private-export');
  const output = path.join(outputDir, 'agentmonitor.db');
  fs.mkdirSync(outputDir, { mode: 0o700 });
  fs.chmodSync(outputDir, 0o700);

  const writer = new Database(source);
  writer.pragma('journal_mode = WAL');
  writer.exec(`
    CREATE TABLE backup_canary (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO backup_canary (value) VALUES ('captured-before-backup');
  `);

  return { root, source, outputDir, output, writer };
}

function cleanupFixture(fixture: Fixture): void {
  fixture.writer.close();
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test('database backup creates a private validated copy while the source remains writable', async () => {
  const fixture = newFixture('success');
  try {
    const beforeCount = (fixture.writer.prepare('SELECT COUNT(*) AS count FROM backup_canary').get() as { count: number }).count;
    const backupRun = runCli([
      '--db-path',
      fixture.source,
      'database',
      'backup',
      '--output',
      fixture.output,
      '--json',
    ]);
    fixture.writer.prepare('INSERT INTO backup_canary (value) VALUES (?)').run('written-during-backup');
    const result = await backupRun;

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, '');
    const payload = JSON.parse(result.stdout) as {
      status: string;
      output: string;
      bytes: number;
      total_pages: number;
      journal_mode: string;
      integrity_check: string;
      foreign_key_violations: number;
      replaced: boolean;
    };
    assert.deepEqual(
      {
        status: payload.status,
        output: payload.output,
        journal_mode: payload.journal_mode,
        integrity_check: payload.integrity_check,
        foreign_key_violations: payload.foreign_key_violations,
        replaced: payload.replaced,
      },
      {
        status: 'ok',
        output: path.join(fs.realpathSync(fixture.outputDir), path.basename(fixture.output)),
        journal_mode: 'delete',
        integrity_check: 'ok',
        foreign_key_violations: 0,
        replaced: false,
      },
    );
    assert.ok(payload.bytes > 0);
    assert.ok(payload.total_pages > 0);
    assert.equal(fs.statSync(fixture.output).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(`${fixture.output}-wal`), false);
    assert.equal(fs.existsSync(`${fixture.output}-shm`), false);

    const exported = new Database(fixture.output, { readonly: true, fileMustExist: true });
    try {
      assert.equal(exported.pragma('integrity_check', { simple: true }), 'ok');
      const exportedCount = (
        exported.prepare('SELECT COUNT(*) AS count FROM backup_canary').get() as { count: number }
      ).count;
      assert.ok(exportedCount === beforeCount || exportedCount === beforeCount + 1);
    } finally {
      exported.close();
    }
    assert.equal(fs.existsSync(`${fixture.output}-wal`), false);
    assert.equal(fs.existsSync(`${fixture.output}-shm`), false);

    assert.equal(
      (fixture.writer.prepare('SELECT COUNT(*) AS count FROM backup_canary').get() as { count: number }).count,
      beforeCount + 1,
    );
    fixture.writer.prepare('INSERT INTO backup_canary (value) VALUES (?)').run('written-after-backup');
    assert.equal(
      (fixture.writer.prepare('SELECT COUNT(*) AS count FROM backup_canary').get() as { count: number }).count,
      beforeCount + 2,
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test('database backup refuses an existing export unless replacement is explicit and atomic', async () => {
  const fixture = newFixture('replace');
  const previous = new Database(fixture.output);
  try {
    previous.exec(`
      CREATE TABLE previous_export (value TEXT NOT NULL);
      INSERT INTO previous_export (value) VALUES ('keep-until-replaced');
    `);

    const refused = await runCli([
      '--db-path', fixture.source,
      'database', 'backup',
      '--output', fixture.output,
    ]);
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /already exists.*--replace/);
    assert.equal(
      (previous.prepare('SELECT value FROM previous_export').get() as { value: string }).value,
      'keep-until-replaced',
    );

    const replaced = await runCli([
      '--db-path', fixture.source,
      'database', 'backup',
      '--output', fixture.output,
      '--replace',
      '--json',
    ]);
    assert.equal(replaced.exitCode, 0, replaced.stderr);
    assert.equal((JSON.parse(replaced.stdout) as { replaced: boolean }).replaced, true);

    // An open reader retains the old inode while a new reader sees the complete
    // replacement, proving the command did not rewrite the published file in place.
    assert.equal(
      (previous.prepare('SELECT value FROM previous_export').get() as { value: string }).value,
      'keep-until-replaced',
    );
    const current = new Database(fixture.output, { readonly: true, fileMustExist: true });
    try {
      assert.equal(
        (current.prepare('SELECT value FROM backup_canary').get() as { value: string }).value,
        'captured-before-backup',
      );
      assert.equal(current.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      current.close();
    }
    assert.deepEqual(fs.readdirSync(fixture.outputDir), ['agentmonitor.db']);
  } finally {
    previous.close();
    cleanupFixture(fixture);
  }
});

test('database backup rejects unsafe destinations without changing their targets', async () => {
  const fixture = newFixture('unsafe');
  try {
    const relative = await runCli([
      '--db-path', fixture.source,
      'database', 'backup',
      '--output', 'relative.db',
    ]);
    assert.equal(relative.exitCode, 2);
    assert.match(relative.stderr, /absolute/);

    const sourceTarget = await runCli([
      '--db-path', fixture.source,
      'database', 'backup',
      '--output', fixture.source,
      '--replace',
    ]);
    assert.equal(sourceTarget.exitCode, 2);
    assert.match(sourceTarget.stderr, /source database/);
    assert.equal(
      (fixture.writer.prepare('SELECT value FROM backup_canary').get() as { value: string }).value,
      'captured-before-backup',
    );

    const sidecarTarget = await runCli([
      '--db-path', fixture.source,
      'database', 'backup',
      '--output', `${fixture.source}-wal`,
      '--replace',
    ]);
    assert.equal(sidecarTarget.exitCode, 2);
    assert.match(sidecarTarget.stderr, /source database or its sidecars/);
    fixture.writer.prepare('INSERT INTO backup_canary (value) VALUES (?)').run('source-still-writable');

    const broadDir = path.join(fixture.root, 'broad-output');
    fs.mkdirSync(broadDir, { mode: 0o755 });
    fs.chmodSync(broadDir, 0o755);
    const broad = await runCli([
      '--db-path', fixture.source,
      'database', 'backup',
      '--output', path.join(broadDir, 'agentmonitor.db'),
    ]);
    assert.equal(broad.exitCode, 2);
    assert.match(broad.stderr, /parent directory.*private/);
    assert.deepEqual(fs.readdirSync(broadDir), []);

    const sentinel = path.join(fixture.root, 'sentinel.txt');
    const symlink = path.join(fixture.outputDir, 'agentmonitor.db');
    fs.writeFileSync(sentinel, 'do-not-replace');
    fs.symlinkSync(sentinel, symlink);
    const linked = await runCli([
      '--db-path', fixture.source,
      'database', 'backup',
      '--output', symlink,
      '--replace',
    ]);
    assert.equal(linked.exitCode, 2);
    assert.match(linked.stderr, /symbolic link/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do-not-replace');
    assert.equal(fs.lstatSync(symlink).isSymbolicLink(), true);
  } finally {
    cleanupFixture(fixture);
  }
});
