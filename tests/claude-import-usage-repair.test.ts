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
const { maintainSessionTraceSummary } = await import('../src/trace-quality/summary.js');

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

  test('still matches rows stored under the legacy positional id', () => {
    // Ids moved onto the producer's uuid, but every row imported before that
    // change is keyed by the positional scheme. Indexing corrections only by the
    // new id would silently reclassify all of that repairable history as
    // "no surviving transcript" and leave its inflated usage in place.
    const sessionId = 'sess-legacy-keyed';
    const claudeDir = claudeDirFor(sessionId);
    const dir = path.join(claudeDir, 'projects', '-Users-someone-project');
    fs.mkdirSync(dir, { recursive: true });
    const line = (content: unknown, uuid: string) => JSON.stringify({
      type: 'assistant',
      sessionId,
      uuid,
      timestamp: '2026-02-01T10:00:00Z',
      message: { id: 'msg_01Turn', model: MODEL, usage: USAGE, content },
    });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
      line([{ type: 'thinking', thinking: 'deciding' }], 'uuid-lk-0'),
      line([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], 'uuid-lk-1'),
      line([{ type: 'text', text: 'done' }], 'uuid-lk-2'),
    ].join('\n'));
    // The orphan count is global to the database, and earlier tests leave rows
    // behind, so compare against a baseline rather than expecting zero.
    const baselineOrphans = repairClaudeImportUsage(getDb(), { claudeDir, apply: false })
      .rows_without_transcript;
    seedInflatedRows(sessionId, 3); // stored under legacy ids, as production is

    const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

    assert.equal(report.rows_corrected, 2, 'the two repeat lines are still repairable');
    assert.equal(
      report.rows_without_transcript,
      baselineOrphans,
      'legacy-keyed rows must not be reclassified as having no transcript',
    );
    const after = totals(sessionId);
    assert.equal(after.rows, 3);
    assert.equal(after.tokens_out, USAGE.output_tokens);
  });

  test('refuses rows whose event id is claimed by more than one transcript', () => {
    // A Claude child-agent transcript embeds its PARENT's sessionId, and event
    // ids are derived from (sessionId, line index) — so a subagent file and its
    // parent mint identical ids for the same line number. Correcting such a row
    // from whichever file sorts later would write another transcript's tokens.
    const sessionId = 'sess-ambiguous';
    const claudeDir = claudeDirFor(sessionId);
    writeTranscript(claudeDir, sessionId);
    const subagentDir = path.join(claudeDir, 'projects', '-Users-someone-project', sessionId, 'subagents');
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(path.join(subagentDir, 'agent-child.jsonl'), [
      JSON.stringify({
        type: 'assistant',
        sessionId, // the parent's id, as real child-agent transcripts carry
        isSidechain: true,
        timestamp: '2026-02-01T10:05:00Z',
        message: { id: 'msg_02Child', model: MODEL, usage: { input_tokens: 7, output_tokens: 9 }, content: [{ type: 'text', text: 'child' }] },
      }),
    ].join('\n'));
    seedInflatedRows(sessionId, 3);
    // Line 0 is the colliding one: both transcripts mint this id.
    const collidingId = `import-cc-${crypto.createHash('sha256')
      .update(`claude-code:${sessionId}:0`).digest('hex').slice(0, 32)}`;
    const before = getDb()
      .prepare('SELECT tokens_in, tokens_out, cost_usd FROM events WHERE event_id = ?')
      .get(collidingId);

    const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

    assert.ok(report.rows_ambiguous >= 1, 'colliding event ids must be reported');
    assert.deepEqual(
      getDb().prepare('SELECT tokens_in, tokens_out, cost_usd FROM events WHERE event_id = ?').get(collidingId),
      before,
      'the contested row keeps its own values rather than the child transcript\'s',
    );
    // Lines 1 and 2 are claimed by one transcript only, so they are still repaired.
    assert.equal(report.rows_corrected, 2);
  });

  test('re-derives the persisted trace summary for repaired sessions', () => {
    // session_trace_summary stores its own token/cost rollup, and both the
    // trace-quality API and warehouse export read it directly. Leaving it stale
    // would keep serving the inflated numbers after the events were fixed.
    const sessionId = 'sess-summary';
    const claudeDir = claudeDirFor(sessionId);
    writeTranscript(claudeDir, sessionId);
    seedInflatedRows(sessionId, 3);
    maintainSessionTraceSummary(sessionId);
    const stale = getDb()
      .prepare('SELECT tokens_out FROM session_trace_summary WHERE session_id = ?')
      .get(sessionId) as { tokens_out: number } | undefined;
    assert.equal(stale?.tokens_out, USAGE.output_tokens * 3, 'summary starts from the inflated rows');

    repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

    const fresh = getDb()
      .prepare('SELECT tokens_out FROM session_trace_summary WHERE session_id = ?')
      .get(sessionId) as { tokens_out: number };
    assert.equal(fresh.tokens_out, USAGE.output_tokens, 'summary follows the repaired events');
  });
});
