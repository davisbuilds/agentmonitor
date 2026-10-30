import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-cache-savings-1h-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
process.env.AGENTMONITOR_TIMEZONE = 'UTC';
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const queries = await import('../src/db/v2-queries.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
// Opus 5.5: input $4/M, cache read $0.20/M, 5-minute write $5/M, 1-hour write $8/M.
db.prepare(`INSERT INTO events
  (session_id, agent_type, event_type, model, tokens_in, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, client_timestamp, source)
  VALUES ('s', 'claude_code', 'llm_response', 'claude-opus-5-5', 1, 1000000, 1000000, 500000, '2026-03-02T10:00:00Z', 'import')`).run();

test('cache savings charge 1-hour writes their own premium', () => {
  const summary = queries.getUsageSummary({ date_from: '2026-03-01', date_to: '2026-03-31' });
  // Reads save $3.80; the 5-minute half costs $0.50 over input, the 1-hour half $2.00.
  assert.equal(summary.estimated_cache_savings_usd, 1.3);
});
