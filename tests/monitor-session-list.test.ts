import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import type { getDb as getDbType, closeDb as closeDbType } from '../src/db/connection.js';
import type { initSchema as initSchemaType } from '../src/db/schema.js';

let tempDir = '';
let getDb: typeof getDbType;
let closeDb: typeof closeDbType;
let initSchema: typeof initSchemaType;

// The original per-session correlated-subquery query (pre-rewrite). Kept here as
// the parity oracle: the production CTE query must return byte-identical rows.
const OLD_SQL = `
  SELECT s.*,
    COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0) as event_count,
    COALESCE((SELECT SUM(e.tokens_in) FROM events e WHERE e.session_id = s.id), 0) as tokens_in,
    COALESCE((SELECT SUM(e.tokens_out) FROM events e WHERE e.session_id = s.id), 0) as tokens_out,
    COALESCE((SELECT SUM(e.cost_usd) FROM events e WHERE e.session_id = s.id), 0) as total_cost_usd,
    COALESCE((SELECT COUNT(DISTINCT json_extract(e.metadata, '$.file_path')) FROM events e WHERE e.session_id = s.id AND json_valid(e.metadata) = 1 AND e.tool_name IN ('Edit', 'Write', 'MultiEdit', 'apply_patch', 'write_stdin') AND json_extract(e.metadata, '$.file_path') IS NOT NULL), 0) as files_edited,
    COALESCE((SELECT SUM(CAST(json_extract(e.metadata, '$.lines_added') AS INTEGER)) FROM events e WHERE e.session_id = s.id AND json_valid(e.metadata) = 1 AND json_extract(e.metadata, '$.lines_added') IS NOT NULL), 0) as lines_added,
    COALESCE((SELECT SUM(CAST(json_extract(e.metadata, '$.lines_removed') AS INTEGER)) FROM events e WHERE e.session_id = s.id AND json_valid(e.metadata) = 1 AND json_extract(e.metadata, '$.lines_removed') IS NOT NULL), 0) as lines_removed
  FROM sessions s
  ORDER BY
    CASE s.status WHEN 'active' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
    datetime(s.last_event_at) DESC,
    s.id DESC
  __LIMIT__
`;

// The new grouped-aggregate query the production code adopts. Pages sessions
// first, then computes all seven aggregates in a single grouped pass restricted
// to the paged sessions, instead of 7 correlated subqueries per row.
const NEW_SQL = `
  WITH page AS (
    SELECT s.*
    FROM sessions s
    ORDER BY
      CASE s.status WHEN 'active' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
      datetime(s.last_event_at) DESC,
      s.id DESC
    __LIMIT__
  ),
  agg AS (
    SELECT
      e.session_id,
      COUNT(*) AS event_count,
      SUM(e.tokens_in) AS tokens_in,
      SUM(e.tokens_out) AS tokens_out,
      SUM(e.cost_usd) AS total_cost_usd,
      COUNT(DISTINCT CASE
        WHEN json_valid(e.metadata) = 1
          AND e.tool_name IN ('Edit', 'Write', 'MultiEdit', 'apply_patch', 'write_stdin')
          AND json_extract(e.metadata, '$.file_path') IS NOT NULL
        THEN json_extract(e.metadata, '$.file_path')
      END) AS files_edited,
      SUM(CASE
        WHEN json_valid(e.metadata) = 1 AND json_extract(e.metadata, '$.lines_added') IS NOT NULL
        THEN CAST(json_extract(e.metadata, '$.lines_added') AS INTEGER)
      END) AS lines_added,
      SUM(CASE
        WHEN json_valid(e.metadata) = 1 AND json_extract(e.metadata, '$.lines_removed') IS NOT NULL
        THEN CAST(json_extract(e.metadata, '$.lines_removed') AS INTEGER)
      END) AS lines_removed
    FROM events e
    WHERE e.session_id IN (SELECT id FROM page)
    GROUP BY e.session_id
  )
  SELECT
    page.*,
    COALESCE(agg.event_count, 0) AS event_count,
    COALESCE(agg.tokens_in, 0) AS tokens_in,
    COALESCE(agg.tokens_out, 0) AS tokens_out,
    COALESCE(agg.total_cost_usd, 0) AS total_cost_usd,
    COALESCE(agg.files_edited, 0) AS files_edited,
    COALESCE(agg.lines_added, 0) AS lines_added,
    COALESCE(agg.lines_removed, 0) AS lines_removed
  FROM page
  LEFT JOIN agg ON agg.session_id = page.id
  ORDER BY
    CASE page.status WHEN 'active' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
    datetime(page.last_event_at) DESC,
    page.id DESC
`;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-monitor-list-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'monitor-list.db');

  const schema = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema = schema.initSchema;
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  initSchema();
  seed();
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seed(): void {
  const db = getDb();
  const session = db.prepare(
    `INSERT INTO sessions (id, agent_id, agent_type, project, status, last_event_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // Tied last_event_at on A/B to exercise the id-DESC tiebreak; C has zero events.
  session.run('sess-a', 'agent-1', 'claude', 'proj-x', 'active', '2026-05-01T10:00:00Z');
  session.run('sess-b', 'agent-1', 'claude', 'proj-x', 'idle', '2026-05-01T10:00:00Z');
  session.run('sess-c', 'agent-2', 'codex', 'proj-y', 'ended', '2026-04-20T08:00:00Z');
  session.run('sess-d', 'agent-2', 'codex', 'proj-y', 'active', '2026-05-02T09:00:00Z');

  const event = db.prepare(
    `INSERT INTO events (event_id, session_id, agent_type, event_type, tool_name, created_at, tokens_in, tokens_out, cost_usd, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // sess-a: two edits on the SAME file (distinct files = 1), one tool with no metadata, one NULL-cost row.
  event.run('a1', 'sess-a', 'claude', 'tool_use', 'Edit', '2026-05-01T09:00:00Z', 100, 50, 0.01,
    JSON.stringify({ file_path: '/repo/foo.ts', lines_added: 10, lines_removed: 2 }));
  event.run('a2', 'sess-a', 'claude', 'tool_use', 'Write', '2026-05-01T09:05:00Z', 200, 80, 0.02,
    JSON.stringify({ file_path: '/repo/foo.ts', lines_added: 5, lines_removed: 0 }));
  event.run('a3', 'sess-a', 'claude', 'tool_use', 'Bash', '2026-05-01T09:10:00Z', 10, null, null, '{}');
  // sess-b: single event, all token columns NULL, non-JSON metadata (json_valid guard must skip it).
  event.run('b1', 'sess-b', 'claude', 'response', null, '2026-05-01T09:30:00Z', null, null, null, 'not json');
  // sess-d: two edits on DIFFERENT files (distinct files = 2).
  event.run('d1', 'sess-d', 'codex', 'tool_use', 'apply_patch', '2026-05-02T08:00:00Z', 300, 120, 0.05,
    JSON.stringify({ file_path: '/repo/a.py', lines_added: 30, lines_removed: 4 }));
  event.run('d2', 'sess-d', 'codex', 'tool_use', 'apply_patch', '2026-05-02T08:30:00Z', 150, 60, 0.03,
    JSON.stringify({ file_path: '/repo/b.py', lines_added: 7, lines_removed: 1 }));
  // sess-c intentionally has no events.
}

function run(sql: string, limit: number | null): unknown[] {
  const finalSql = sql.replace('__LIMIT__', limit == null ? '' : `LIMIT ${limit}`);
  return getDb().prepare(finalSql).all();
}

test('grouped-aggregate session list matches the correlated-subquery oracle (no limit)', () => {
  assert.deepEqual(run(NEW_SQL, null), run(OLD_SQL, null));
});

test('grouped-aggregate session list matches the oracle under a small page limit', () => {
  // Exercises the paged-aggregate restriction (WHERE session_id IN page).
  assert.deepEqual(run(NEW_SQL, 2), run(OLD_SQL, 2));
});

test('aggregates are correct for representative sessions', () => {
  const rows = run(NEW_SQL, null) as Array<Record<string, unknown>>;
  const byId = new Map(rows.map(r => [r.id as string, r]));

  const a = byId.get('sess-a')!;
  assert.equal(a.event_count, 3);
  assert.equal(a.tokens_in, 310);
  assert.equal(a.files_edited, 1, 'same file edited twice counts once');
  assert.equal(a.lines_added, 15);

  const b = byId.get('sess-b')!;
  assert.equal(b.event_count, 1);
  assert.equal(b.tokens_in, 0, 'NULL token sums coalesce to 0');
  assert.equal(b.files_edited, 0, 'non-JSON metadata is skipped');

  const c = byId.get('sess-c')!;
  assert.equal(c.event_count, 0, 'session with no events');
  assert.equal(c.total_cost_usd, 0);

  const d = byId.get('sess-d')!;
  assert.equal(d.files_edited, 2, 'two distinct files');
  assert.equal(d.lines_added, 37);
});
