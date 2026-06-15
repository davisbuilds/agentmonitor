import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test, { before } from 'node:test';
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

let tempDir = '';
let claudeDir = '';
let codexHome = '';

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');
  process.env.AGENTMONITOR_USAGE_BUDGETS_PATH = path.join(tempDir, 'budgets.json');
  claudeDir = path.join(tempDir, 'claude');
  codexHome = path.join(tempDir, 'codex');
  fs.mkdirSync(path.join(claudeDir, 'projects', 'project-a'), { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });

  const { initSchema } = await import('../src/db/schema.js');
  const { closeDb, getDb } = await import('../src/db/connection.js');
  initSchema();
  const db = getDb();
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, file_path, file_size, file_hash
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'cli-session-001',
    'agentmonitor',
    'codex',
    'Investigate CLI behavior',
    '2026-06-15T10:00:00.000Z',
    null,
    2,
    1,
    '/tmp/session.jsonl',
    100,
    'hash',
  );
  db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('cli-session-001', 0, 'user', 'Investigate CLI behavior', '2026-06-15T10:00:00.000Z', 0, 0, 24);
  db.prepare(`
    INSERT INTO events (
      session_id, agent_type, event_type, status, tokens_in, tokens_out, project,
      created_at, model, cost_usd, source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'cli-session-001',
    'codex',
    'llm_response',
    'success',
    100,
    50,
    'agentmonitor',
    '2026-06-15T10:00:00.000Z',
    'gpt-5.4',
    0.001,
    'import',
  );
  closeDb();
});

test('sessions list emits JSON from the configured database', async () => {
  const result = await runCli(['sessions', 'list', '--json', '--limit', '5']);

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout) as { data: Array<{ id: string }> };
  assert.equal(parsed.data[0]?.id, 'cli-session-001');
});

test('sessions show returns exit 4 for missing sessions', async () => {
  const result = await runCli(['sessions', 'show', 'missing-session']);

  assert.equal(result.exitCode, 4);
  assert.match(result.stderr, /Session not found/);
});

test('usage summary emits cost totals as JSON', async () => {
  const result = await runCli(['usage', 'summary', '--json']);

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout) as { total_cost_usd: number; total_usage_events: number };
  assert.equal(parsed.total_cost_usd, 0.001);
  assert.equal(parsed.total_usage_events, 1);
});

test('sync sessions dry-run previews discovered files without writing', async () => {
  fs.writeFileSync(path.join(claudeDir, 'projects', 'project-a', 'empty.jsonl'), '');
  const result = await runCli([
    'sync',
    'sessions',
    '--dry-run',
    '--claude-dir',
    claudeDir,
    '--codex-home',
    codexHome,
    '--json',
  ]);

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout) as { dry_run: boolean; total_files: number };
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.total_files, 1);
});

test('hooks print-codex-config uses the requested URL', async () => {
  const result = await runCli(['--url', 'http://127.0.0.1:3999', 'hooks', 'print-codex-config']);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /endpoint = "http:\/\/127\.0\.0\.1:3999\/api\/otel\/v1\/logs"/);
  assert.match(result.stdout, /endpoint = "http:\/\/127\.0\.0\.1:3999\/api\/otel\/v1\/metrics"/);
});
