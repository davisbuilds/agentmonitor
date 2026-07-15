import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test, { after, before, beforeEach } from 'node:test';
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
let dbPath = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let initSchema: typeof import('../src/db/schema.js').initSchema;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let getDb: typeof import('../src/db/connection.js').getDb;
/* eslint-enable @typescript-eslint/consistent-type-imports */

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cli-contracts-'));
  claudeDir = path.join(tempDir, 'claude');
  dbPath = path.join(tempDir, 'contracts.db');
  process.env.AGENTMONITOR_DB_PATH = dbPath;
  process.env.AGENTMONITOR_USAGE_BUDGETS_PATH = path.join(tempDir, 'budgets.json');
  delete process.env.AGENTMONITOR_WAREHOUSE_DSN;

  ({ initSchema } = await import('../src/db/schema.js'));
  ({ closeDb, getDb } = await import('../src/db/connection.js'));
  initSchema();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  closeDb();
  initSchema();
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(claudeDir, 'projects', 'project-a'), { recursive: true });
  const activeDb = getDb();
  assert.equal(
    path.resolve(activeDb.name),
    path.resolve(dbPath),
    'destructive CLI fixture must be connected to its temporary database',
  );
  activeDb.exec(`
    DELETE FROM session_trace_summary;
    DELETE FROM tool_calls;
    DELETE FROM messages;
    DELETE FROM browsing_sessions;
    DELETE FROM events;
    DELETE FROM import_state;
  `);
  seedContractData();
});

function seedContractData(): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, first_message, started_at, ended_at, message_count,
      user_message_count, integration_mode, fidelity, capabilities_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'contract-session',
    'agentmonitor',
    'codex',
    'Contract session',
    '2026-06-15T10:00:00.000Z',
    null,
    2,
    1,
    'claude-jsonl',
    'full',
    '{"tool_analytics":"full","history":"full","search":"full","live_items":"full"}',
  );

  const messageId = Number(db.prepare(`
    INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'contract-session',
    0,
    'assistant',
    'Used Bash',
    '2026-06-15T10:00:30.000Z',
    0,
    1,
    9,
  ).lastInsertRowid);

  db.prepare(`
    INSERT INTO tool_calls (message_id, session_id, tool_name, category, tool_use_id, input_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(messageId, 'contract-session', 'Bash', 'Shell', 'tool-1', '{"command":"pwd"}');

  db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, status, tokens_in, tokens_out,
      cache_read_tokens, cache_write_tokens, project, created_at, client_timestamp,
      model, cost_usd, source, tool_name, duration_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'evt-usage-1',
    'contract-session',
    'codex',
    'llm_response',
    'success',
    100,
    50,
    10,
    0,
    'agentmonitor',
    '2026-06-15 10:00:00',
    '2026-06-15T10:00:00.000Z',
    'gpt-5.4',
    0.001,
    'import',
    null,
    null,
    'evt-reprice',
    'contract-session',
    'codex',
    'llm_response',
    'success',
    25,
    10,
    0,
    0,
    'agentmonitor',
    '2026-06-15 10:01:00',
    '2026-06-15T10:01:00.000Z',
    'gpt-5.4',
    null,
    'api',
    null,
    null,
  );

}

function countRows(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function eventCost(eventId: string): number | null {
  return (getDb().prepare('SELECT cost_usd FROM events WHERE event_id = ?').get(eventId) as { cost_usd: number | null }).cost_usd;
}

test('reporting commands preserve JSON data and coverage contracts', async () => {
  const daily = await runCli(['usage', 'daily', '--json']);
  assert.equal(daily.exitCode, 0, daily.stderr);
  const dailyJson = JSON.parse(daily.stdout) as { data: Array<{ date: string }>; coverage?: { metric_scope: string } };
  assert.equal(dailyJson.data[0]?.date, '2026-06-15');
  assert.equal(dailyJson.coverage?.metric_scope, 'event_usage');

  const models = await runCli(['usage', 'models', '--json']);
  assert.equal(models.exitCode, 0, models.stderr);
  const modelsJson = JSON.parse(models.stdout) as { data: Array<{ model: string }>; coverage?: { usage_events: number } };
  assert.equal(modelsJson.data[0]?.model, 'gpt-5.4');
  assert.equal(modelsJson.coverage?.usage_events, 2);

  const projects = await runCli(['usage', 'projects', '--json']);
  assert.equal(projects.exitCode, 0, projects.stderr);
  const projectsJson = JSON.parse(projects.stdout) as { data: Array<{ project: string }>; coverage?: { usage_sessions: number } };
  assert.equal(projectsJson.data[0]?.project, 'agentmonitor');
  assert.equal(projectsJson.coverage?.usage_sessions, 1);

  const tools = await runCli(['analytics', 'tools', '--json']);
  assert.equal(tools.exitCode, 0, tools.stderr);
  const toolsJson = JSON.parse(tools.stdout) as { data: Array<{ tool_name: string }>; coverage?: { metric_scope: string } };
  assert.equal(toolsJson.data[0]?.tool_name, 'Bash');
  assert.equal(toolsJson.coverage?.metric_scope, 'tool_analytics_capable');

  const traces = await runCli(['quality', 'traces', '--json']);
  assert.equal(traces.exitCode, 0, traces.stderr);
  const tracesJson = JSON.parse(traces.stdout) as { data: unknown[]; coverage?: { matching_traces: number } };
  assert.ok(Array.isArray(tracesJson.data));
  assert.equal(typeof tracesJson.coverage?.matching_traces, 'number');
});

test('invalid numeric reporting filters exit with invalid usage', async () => {
  const result = await runCli(['quality', 'traces', '--min-score', 'nope']);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Invalid --min-score: nope/);
});

test('import dry-run reports parse results without writing events or import state', async () => {
  fs.writeFileSync(
    path.join(claudeDir, 'projects', 'project-a', 'dry-run-session.jsonl'),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'dry-run-session',
      model: 'claude-sonnet-4-5-20250929',
      timestamp: '2026-06-15T12:00:00Z',
      usage: { input_tokens: 20, output_tokens: 10 },
    }),
  );
  const beforeEvents = countRows('events');
  const beforeImportState = countRows('import_state');

  const result = await runCli([
    'import',
    '--source',
    'claude-code',
    '--claude-dir',
    claudeDir,
    '--dry-run',
    '--json',
  ]);

  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { dry_run: boolean; total_files: number; events_found: number };
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.total_files, 1);
  assert.equal(parsed.events_found, 1);
  assert.equal(countRows('events'), beforeEvents);
  assert.equal(countRows('import_state'), beforeImportState);
});

test('cost recalculation dry-run leaves event costs unchanged', async () => {
  assert.equal(eventCost('evt-reprice'), null);

  const result = await runCli(['costs', 'recalc', '--dry-run', '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { dry_run: boolean; scanned: number; updated: number };
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.scanned, 2);
  assert.ok(parsed.updated >= 1);
  assert.equal(eventCost('evt-reprice'), null);
});

test('warehouse publish dry-run reports planned rows without a warehouse DSN', async () => {
  const result = await runCli(['warehouse', 'publish', '--dry-run', '--json']);

  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    dry_run: boolean;
    account: string;
    rows_planned: number;
    rows_suppressed: number;
    statements: string[];
  };
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.account, 'local');
  assert.equal(parsed.rows_planned, 1);
  assert.equal(parsed.rows_suppressed, 0);
  assert.ok(parsed.statements.some(statement => statement.includes('INSERT INTO agentmonitor.runs')));
});

test('warehouse publish without dry-run fails clearly when no DSN is configured', async () => {
  const result = await runCli(['warehouse', 'publish']);

  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /set AGENTMONITOR_WAREHOUSE_DSN/);
});
