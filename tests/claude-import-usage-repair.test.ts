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
const { pricingRegistry } = await import('../src/pricing/index.js');

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

  describe('a producer line is billed once', () => {
    const legacyId = (sessionId: string, index: number) => `import-cc-${crypto.createHash('sha256')
      .update(`claude-code:${sessionId}:${index}`).digest('hex').slice(0, 32)}`;
    const uuidId = (uuid: string) => `import-ccu-${crypto.createHash('sha256')
      .update(`claude-code:uuid:${uuid}`).digest('hex').slice(0, 32)}`;

    /** A transcript of single-line turns: [uuid, messageId, timestamp] per line. */
    function writeTurns(claudeDir: string, sessionId: string, turns: Array<[string, string, string]>): void {
      const dir = path.join(claudeDir, 'projects', '-Users-someone-project');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), turns.map(([uuid, messageId, timestamp]) => JSON.stringify({
        type: 'assistant',
        sessionId,
        uuid,
        timestamp,
        message: { id: messageId, model: MODEL, usage: USAGE, content: [{ type: 'text', text: 'done' }] },
      })).join('\n'));
    }

    function seedRow(eventId: string, sessionId: string): void {
      getDb().prepare(`
        INSERT INTO events (event_id, session_id, agent_type, event_type, status,
          tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, model, cost_usd,
          source, client_timestamp)
        VALUES (?, ?, 'claude_code', 'llm_response', 'success', ?, ?, ?, ?, ?, 0.5, 'import', '2026-02-01T10:00:00Z')
      `).run(eventId, sessionId, USAGE.input_tokens, USAGE.output_tokens,
        USAGE.cache_read_input_tokens, USAGE.cache_creation_input_tokens, MODEL);
    }

    function row(eventId: string) {
      return getDb().prepare('SELECT tokens_out, cost_usd FROM events WHERE event_id = ?')
        .get(eventId) as { tokens_out: number; cost_usd: number };
    }

    test('a line stored under both its uuid id and its legacy id keeps the uuid row', () => {
      // An importer that predates uuid ids stored the line positionally; a later
      // one stored it again under its uuid, before the legacy bridge existed.
      const sessionId = 'sess-dual-id';
      const claudeDir = claudeDirFor(sessionId);
      writeTurns(claudeDir, sessionId, [['uuid-dual-0', 'msg_dual', '2026-02-01T10:00:00Z']]);
      seedRow(legacyId(sessionId, 0), sessionId);
      seedRow(uuidId('uuid-dual-0'), sessionId);

      const dry = repairClaudeImportUsage(getDb(), { claudeDir, apply: false });
      assert.deepEqual([dry.rows_corrected, dry.rows_deduplicated], [1, 1]);
      assert.equal(row(legacyId(sessionId, 0)).tokens_out, USAGE.output_tokens, 'dry run must not write');

      const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

      assert.deepEqual([report.rows_corrected, report.rows_deduplicated], [1, 1]);
      assert.deepEqual(row(uuidId('uuid-dual-0')), { tokens_out: USAGE.output_tokens, cost_usd: 0.5 });
      assert.deepEqual(row(legacyId(sessionId, 0)), { tokens_out: 0, cost_usd: 0 });
      assert.equal(repairClaudeImportUsage(getDb(), { claudeDir, apply: true }).rows_corrected, 0,
        'a second run finds nothing left');
    });

    test('a repeat line stored under both ids is corrected, not counted as a duplicate', () => {
      // The turn's second line contributes nothing, so neither of its rows bills
      // a line another row bills; both are ordinary repeat-line corrections.
      const sessionId = 'sess-dual-id-repeat';
      const claudeDir = claudeDirFor(sessionId);
      writeTurns(claudeDir, sessionId, [
        ['uuid-dual-repeat-0', 'msg_dual_repeat', '2026-02-01T10:00:00Z'],
        ['uuid-dual-repeat-1', 'msg_dual_repeat', '2026-02-01T10:00:00Z'],
      ]);
      seedRow(uuidId('uuid-dual-repeat-0'), sessionId);
      seedRow(legacyId(sessionId, 1), sessionId);
      seedRow(uuidId('uuid-dual-repeat-1'), sessionId);

      const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

      assert.deepEqual([report.rows_corrected, report.rows_deduplicated], [2, 0]);
      assert.equal(totals(sessionId).tokens_out, USAGE.output_tokens);
    });

    test('copies that disagree on what a line contributes are refused as ambiguous', () => {
      // The copy starts partway through a turn: the copied line is a repeat in the
      // original but the turn's first line in the copy. Neither reading is safe
      // to pick by file order.
      const original = 'sess-disagree-a-original';
      const resumed = 'sess-disagree-b-continued';
      const claudeDir = claudeDirFor(original);
      writeTurns(claudeDir, original, [
        ['uuid-disagree-0', 'msg_disagree', '2026-02-01T10:00:00Z'],
        ['uuid-disagree-1', 'msg_disagree', '2026-02-01T10:00:00Z'],
      ]);
      writeTurns(claudeDir, resumed, [
        ['uuid-disagree-1', 'msg_disagree', '2026-02-01T10:00:00Z'],
        ['uuid-disagree-2', 'msg_disagree_2', '2026-02-01T11:00:00Z'],
      ]);
      seedRow(uuidId('uuid-disagree-1'), resumed);

      const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

      assert.equal(report.rows_ambiguous, 1);
      assert.equal(row(uuidId('uuid-disagree-1')).tokens_out, USAGE.output_tokens, 'the contested row keeps its values');
    });

    test('a positional id a child agent also mints goes to its transcript once the child line has its own row', () => {
      // Under the positional scheme a child agent's line collided with its
      // parent's line of the same number, and whichever was imported first kept
      // the id. When the child won, its line was later stored again under its own
      // id, so it bills twice while the parent's line bills nothing. The parent
      // transcript owns its positional ids, and the child is billed elsewhere.
      const parent = 'sess-collision-parent';
      const claudeDir = claudeDirFor(parent);
      const dir = path.join(claudeDir, 'projects', '-Users-someone-project');
      fs.mkdirSync(path.join(dir, parent, 'subagents'), { recursive: true });
      const parentUsage = { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 500, cache_creation_input_tokens: 5000 };
      fs.writeFileSync(path.join(dir, `${parent}.jsonl`), JSON.stringify({
        type: 'assistant', sessionId: parent, timestamp: '2026-02-01T10:00:00Z',
        message: { id: 'msg_collision_parent', model: MODEL, usage: parentUsage, content: [{ type: 'text', text: 'parent' }] },
      }));
      fs.writeFileSync(path.join(dir, parent, 'subagents', 'agent-collider.jsonl'), JSON.stringify({
        type: 'assistant', sessionId: parent, uuid: 'uuid-collision-child', isSidechain: true, timestamp: '2026-02-01T10:05:00Z',
        message: { id: 'msg_collision_child', model: MODEL, usage: USAGE, content: [{ type: 'text', text: 'child' }] },
      }));
      seedRow(legacyId(parent, 0), parent); // holds the child's usage
      seedRow(uuidId('uuid-collision-child'), parent);
      getDb().prepare("UPDATE events SET cost_source = 'estimated' WHERE event_id = ?").run(legacyId(parent, 0));

      const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

      assert.equal(report.rows_ambiguous, 0);
      assert.equal(row(legacyId(parent, 0)).tokens_out, parentUsage.output_tokens, 'the parent line is billed');
      const repriced = pricingRegistry.calculate(MODEL, {
        input: parentUsage.input_tokens,
        output: parentUsage.output_tokens,
        cacheRead: parentUsage.cache_read_input_tokens,
        cacheWrite: parentUsage.cache_creation_input_tokens,
      }, '2026-02-01T10:00:00Z');
      assert.ok(repriced && repriced !== 0.5);
      assert.ok(Math.abs(row(legacyId(parent, 0)).cost_usd - repriced) < 1e-12,
        'an estimated cost follows the tokens it now bills');
      assert.equal(row(uuidId('uuid-collision-child')).tokens_out, USAGE.output_tokens, 'the child line is billed once');
    });

    test('a child line that bills nothing needs no row of its own to cede the positional id', () => {
      const parent = 'sess-collision-quiet';
      const claudeDir = claudeDirFor(parent);
      const dir = path.join(claudeDir, 'projects', '-Users-someone-project');
      fs.mkdirSync(path.join(dir, parent, 'subagents'), { recursive: true });
      writeTurns(claudeDir, parent, [['uuid-quiet-parent-0', 'msg_quiet_parent', '2026-02-01T10:00:00Z']]);
      fs.writeFileSync(path.join(dir, parent, 'subagents', 'agent-quiet.jsonl'), JSON.stringify({
        type: 'user', sessionId: parent, uuid: 'uuid-quiet-child', isSidechain: true, timestamp: '2026-02-01T10:05:00Z',
        message: { role: 'user', content: 'go' },
      }));
      seedRow(legacyId(parent, 0), parent);
      getDb().prepare("UPDATE events SET tokens_out = 1, cost_source = 'reported' WHERE event_id = ?").run(legacyId(parent, 0));

      const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

      assert.equal(report.rows_ambiguous, 0);
      assert.deepEqual(row(legacyId(parent, 0)), { tokens_out: USAGE.output_tokens, cost_usd: 0.5 },
        'the parent line is restored; a reported cost is not re-estimated');
    });

    test('a positional id two transcripts both own stays ambiguous', () => {
      // The same session's transcript under two project directories, diverged.
      const sessionId = 'sess-two-owners';
      const claudeDir = claudeDirFor(sessionId);
      writeTurns(claudeDir, sessionId, [['uuid-two-owners-a', 'msg_two_owners_a', '2026-02-01T10:00:00Z']]);
      const other = path.join(claudeDir, 'projects', '-Users-someone-other');
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, `${sessionId}.jsonl`), JSON.stringify({
        type: 'assistant', sessionId, uuid: 'uuid-two-owners-b', timestamp: '2026-02-01T10:00:00Z',
        message: { id: 'msg_two_owners_b', model: MODEL, usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
      }));
      seedRow(legacyId(sessionId, 0), sessionId);
      seedRow(uuidId('uuid-two-owners-a'), sessionId);
      seedRow(uuidId('uuid-two-owners-b'), sessionId);

      const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

      assert.equal(report.rows_ambiguous, 1);
      assert.equal(row(legacyId(sessionId, 0)).tokens_out, USAGE.output_tokens, 'the contested row keeps its values');
    });

    test('a copy whose positional id a child-agent transcript also mints is left alone', () => {
      // The resumed session's child agent reports the resumed session id, so its
      // first line mints the same positional id as the copied line. That row may
      // hold the child's usage, not the copy's, so it is not the copy's to zero.
      const original = 'sess-contested-original';
      const resumed = 'sess-contested-continued';
      const claudeDir = claudeDirFor(original);
      writeTurns(claudeDir, original, [['uuid-contested-0', 'msg_contested', '2026-02-01T10:00:00Z']]);
      writeTurns(claudeDir, resumed, [
        ['uuid-contested-0', 'msg_contested', '2026-02-01T10:00:00Z'],
        ['uuid-contested-1', 'msg_contested_1', '2026-02-01T11:00:00Z'],
      ]);
      const childDir = path.join(claudeDir, 'projects', '-Users-someone-project', resumed, 'subagents');
      fs.mkdirSync(childDir, { recursive: true });
      fs.writeFileSync(path.join(childDir, 'agent-child.jsonl'), JSON.stringify({
        type: 'assistant',
        sessionId: resumed,
        isSidechain: true,
        timestamp: '2026-02-01T11:30:00Z',
        message: { id: 'msg_contested_child', model: MODEL, usage: USAGE, content: [{ type: 'text', text: 'child' }] },
      }));
      seedRow(legacyId(original, 0), original);
      seedRow(legacyId(resumed, 0), resumed);

      const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

      assert.equal(report.rows_deduplicated, 0);
      assert.equal(row(legacyId(resumed, 0)).tokens_out, USAGE.output_tokens, 'the contested row keeps its values');
      assert.equal(row(legacyId(original, 0)).tokens_out, USAGE.output_tokens);
    });

    test('history a resumed session copied from its predecessor is billed by the original', () => {
      // Resuming writes a new transcript that repeats the earlier conversation
      // line for line, under the new session id but the same uuids. Positional
      // ids differ per file, so both copies were stored and billed.
      const original = 'sess-resume-original';
      const resumed = 'sess-resume-continued';
      const claudeDir = claudeDirFor(original);
      writeTurns(claudeDir, original, [['uuid-resume-0', 'msg_resume_0', '2026-02-01T10:00:00Z']]);
      writeTurns(claudeDir, resumed, [
        ['uuid-resume-0', 'msg_resume_0', '2026-02-01T10:00:00Z'],
        ['uuid-resume-1', 'msg_resume_1', '2026-02-01T11:00:00Z'],
      ]);
      seedRow(legacyId(original, 0), original);
      seedRow(legacyId(resumed, 0), resumed);
      seedRow(legacyId(resumed, 1), resumed);

      const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

      assert.deepEqual([report.rows_corrected, report.rows_deduplicated], [1, 1]);
      assert.equal(row(legacyId(original, 0)).tokens_out, USAGE.output_tokens, 'the original keeps the line');
      assert.deepEqual(row(legacyId(resumed, 0)), { tokens_out: 0, cost_usd: 0 });
      assert.equal(row(legacyId(resumed, 1)).tokens_out, USAGE.output_tokens, 'the resumed session keeps its own work');
      assert.equal(repairClaudeImportUsage(getDb(), { claudeDir, apply: true }).rows_corrected, 0,
        'a second run neither re-bills the copy nor moves the line');
    });

    test('a copied line with only one stored row keeps it', () => {
      // The original transcript's rows are missing, so the copy is the only
      // record of that turn and must not be zeroed.
      const original = 'sess-copy-only-original';
      const resumed = 'sess-copy-only-continued';
      const claudeDir = claudeDirFor(original);
      writeTurns(claudeDir, original, [['uuid-copy-only-0', 'msg_copy_only', '2026-02-01T10:00:00Z']]);
      writeTurns(claudeDir, resumed, [
        ['uuid-copy-only-0', 'msg_copy_only', '2026-02-01T10:00:00Z'],
        ['uuid-copy-only-1', 'msg_copy_only_1', '2026-02-01T11:00:00Z'],
      ]);
      seedRow(legacyId(resumed, 0), resumed);

      const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

      assert.deepEqual([report.rows_corrected, report.rows_deduplicated], [0, 0]);
      assert.equal(row(legacyId(resumed, 0)).tokens_out, USAGE.output_tokens);
    });

    test('a uuid row claimed by the original and its copy is repairable, not ambiguous', () => {
      // Both transcripts mint the same uuid id for the same producer line, so
      // they agree on what it should contribute.
      const original = 'sess-uuid-shared-original';
      const resumed = 'sess-uuid-shared-continued';
      const claudeDir = claudeDirFor(original);
      const turn: [string, string, string] = ['uuid-shared-0', 'msg_shared', '2026-02-01T10:00:00Z'];
      writeTurns(claudeDir, original, [turn]);
      writeTurns(claudeDir, resumed, [turn, ['uuid-shared-1', 'msg_shared_1', '2026-02-01T11:00:00Z']]);
      seedRow(uuidId('uuid-shared-0'), original);
      seedRow(legacyId(resumed, 0), resumed);

      const report = repairClaudeImportUsage(getDb(), { claudeDir, apply: true });

      assert.equal(report.rows_ambiguous, 0, 'only this test\'s transcripts are scanned');
      assert.equal(report.rows_deduplicated, 1);
      assert.equal(row(uuidId('uuid-shared-0')).tokens_out, USAGE.output_tokens, 'the uuid row is kept');
      assert.equal(row(legacyId(resumed, 0)).tokens_out, 0);
    });
  });
});
