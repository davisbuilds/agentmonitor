import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-usage-repair-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { repairClaudeImportUsage } = await import('../src/import/claude-usage-repair.js');

const USAGE = {
  input_tokens: 2,
  output_tokens: 254,
  cache_read_input_tokens: 21503,
  cache_creation_input_tokens: 23573,
};
const MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Write a transcript whose turn spans three content blocks, as Claude Code does,
 * under a Claude dir of its own so each test scans only its own session.
 */
function writeTranscript(claudeDir: string, sessionId: string): string {
  const dir = path.join(claudeDir, 'projects', '-Users-someone-project');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const line = (content: unknown) => JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: '2026-02-01T10:00:00Z',
    message: { id: 'msg_01Turn', model: MODEL, usage: USAGE, content },
  });
  fs.writeFileSync(filePath, [
    line([{ type: 'thinking', thinking: 'deciding' }]),
    line([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
    line([{ type: 'text', text: 'done' }]),
  ].join('\n'));
  return filePath;
}

/** Insert the rows the pre-fix importer would have written: usage on every line. */
function seedInflatedRows(sessionId: string, lineCount: number): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, status,
      tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, model, cost_usd,
      source, client_timestamp)
    VALUES (?, ?, 'claude_code', 'llm_response', 'success', ?, ?, ?, ?, ?, ?, 'import', '2026-02-01T10:00:00Z')
  `);
  for (let i = 0; i < lineCount; i++) {
    const hash = crypto.createHash('sha256').update(`claude-code:${sessionId}:${i}`).digest('hex').slice(0, 32);
    insert.run(
      `import-cc-${hash}`,
      sessionId,
      USAGE.input_tokens,
      USAGE.output_tokens,
      USAGE.cache_read_input_tokens,
      USAGE.cache_creation_input_tokens,
      MODEL,
      0.5,
    );
  }
}

function totals(sessionId: string) {
  return getDb().prepare(`
    SELECT SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
           SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write,
           SUM(cost_usd) AS cost, COUNT(*) AS rows
    FROM events WHERE session_id = ?
  `).get(sessionId) as {
    tokens_in: number; tokens_out: number; cache_read: number;
    cache_write: number; cost: number; rows: number;
  };
}

describe('Claude import usage repair', () => {
  /** A Claude dir private to one test, so discovery cannot see other tests' sessions. */
  function claudeDirFor(name: string): string {
    const dir = path.join(tempDir, `claude-${name}`);
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    return dir;
  }

  before(() => {
    initSchema();
  });

  after(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('dry run reports the over-billed rows without changing them', () => {
    const sessionId = 'sess-dry';
    const claudeDir = claudeDirFor(sessionId);
    writeTranscript(claudeDir, sessionId);
    seedInflatedRows(sessionId, 3);
    const before = totals(sessionId);

    const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: false });

    assert.equal(report.apply, false);
    assert.equal(report.rows_corrected, 2, 'two repeat lines of the turn carry usage they should not');
    assert.equal(report.tokens_reclaimed, (USAGE.input_tokens + USAGE.output_tokens
      + USAGE.cache_read_input_tokens + USAGE.cache_creation_input_tokens) * 2);
    assert.deepEqual(totals(sessionId), before, 'dry run must not write');
  });

  test('apply keeps every row but bills the turn once', () => {
    const sessionId = 'sess-apply';
    const claudeDir = claudeDirFor(sessionId);
    writeTranscript(claudeDir, sessionId);
    seedInflatedRows(sessionId, 3);

    const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

    assert.equal(report.apply, true);
    assert.equal(report.rows_corrected, 2);

    const after = totals(sessionId);
    assert.equal(after.rows, 3, 'event history is preserved');
    assert.equal(after.tokens_in, USAGE.input_tokens);
    assert.equal(after.tokens_out, USAGE.output_tokens);
    assert.equal(after.cache_read, USAGE.cache_read_input_tokens);
    assert.equal(after.cache_write, USAGE.cache_creation_input_tokens);
    assert.equal(after.cost, 0.5, 'the surviving line keeps its captured cost; duplicates drop to zero');
  });

  test('is idempotent: a second run finds nothing left to correct', () => {
    const sessionId = 'sess-idempotent';
    const claudeDir = claudeDirFor(sessionId);
    writeTranscript(claudeDir, sessionId);
    seedInflatedRows(sessionId, 3);

    repairClaudeImportUsage(getDb(), { claudeDir, apply: true });
    const second = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

    assert.equal(second.rows_corrected, 0);
  });

  test('reports rows whose transcript is gone as unrepairable instead of touching them', () => {
    const sessionId = 'sess-orphan';
    const claudeDir = claudeDirFor(sessionId);
    seedInflatedRows(sessionId, 3); // no transcript written for this session
    const before = totals(sessionId);

    const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

    assert.ok(report.rows_without_transcript >= 3,
      'rows with no source file must be counted, not silently skipped');
    assert.deepEqual(totals(sessionId), before, 'unrepairable rows stay untouched');
  });
});
