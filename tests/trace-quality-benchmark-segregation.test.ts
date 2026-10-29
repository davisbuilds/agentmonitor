import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-quality-benchmark-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const { listSessionTraces } = await import('../src/trace-quality/on-demand.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
const summary = db.prepare(`INSERT INTO session_trace_summary
  (session_id, trace_id, agent_type, started_at, observation_count, projection_version)
  VALUES (?, ?, ?, '2026-03-04T14:00:00Z', 1, 'test')`);
summary.run('mine', 'sts:mine', 'claude');
summary.run('bench-run', 'sts:bench-run', 'opencode');
db.prepare(`INSERT INTO events (session_id, agent_type, event_type, source, client_timestamp)
  VALUES ('bench-run', 'opencode', 'llm_response', 'benchmark', '2026-03-04T14:00:01Z')`).run();

test('Quality lists personal sessions, not imported benchmark runs', () => {
  const list = listSessionTraces({ date_from: '2026-03-01', date_to: '2026-03-31' });
  assert.deepEqual(list.data.map(trace => trace.session_id), ['mine']);
  assert.equal(list.total, 1);
});
