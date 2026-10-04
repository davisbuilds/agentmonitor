import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// An unpriced model bills as $0, not as an error, so a new model's usage piles up
// at $0 until someone notices. These pin the signal that names such models.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-unpriced-models-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { listRecentUnpricedModels, recentUnpricedUsageStatement } = await import('../src/db/v2-queries.js');
const { statsBroadcastPayload } = await import('../src/api/stream.js');
const { createApp } = await import('../src/app.js');

const now = Date.now();
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
const SINCE = new Date(now - 7 * 86_400_000).toISOString();

let server: Server;
let baseUrl = '';

before(async () => {
  initSchema();
  assert.equal(fs.realpathSync(getDb().name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  const insert = getDb().prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, status, model, tokens_in, tokens_out,
      cache_read_tokens, cache_write_tokens, cost_usd, source, created_at, client_timestamp)
    VALUES (?, 's', 'codex', ?, 'success', ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);
  let id = 0;
  const row = (model: string, fields: { type?: string; tin?: number; tout?: number; read?: number; cost?: number | null; source?: string; at?: string; happened?: string } = {}) =>
    insert.run(`e-${id++}`, fields.type ?? 'llm_response', model, fields.tin ?? 10, fields.tout ?? 5, fields.read ?? 0,
      fields.cost === undefined ? null : fields.cost, fields.source ?? 'otel', fields.at ?? daysAgo(1), fields.happened ?? null);
  // An import stamps created_at with the import time and keeps the event's own
  // time in client_timestamp (ISO with zone).
  const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

  row('gpt-new', { at: daysAgo(2) });
  row('gpt-new', { at: daysAgo(1) });
  row('gpt-new', { type: 'session_start', tin: 0, tout: 0 });   // carries no usage
  row('claude-new', { tin: 0, tout: 0, read: 500, at: daysAgo(0), happened: isoDaysAgo(3) }); // cache reads alone are usage
  row('gpt-reimported', { source: 'import', at: daysAgo(0), happened: isoDaysAgo(30) }); // old usage, imported today
  row('gpt-old', { at: daysAgo(10) });                           // outside the window
  row('gpt-6-sol', { cost: 0.01 });                              // priced
  row('claude-harness', { cost: 0.5 });                          // unknown here, but its producer reported a cost
  row('claude-sonnet-5');                                        // has a rate card; startup fills it
  row('codex-auto-review');                                      // no public rate exists
  row('bench-model', { source: 'benchmark' });                   // benchmark import reports its own

  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const expected = [
  { model: 'gpt-new', usage_events: 2, last_seen: daysAgo(1) },
  { model: 'claude-new', usage_events: 1, last_seen: daysAgo(3) },
];

describe('recent unpriced models', () => {
  test('names models with recent usage and no rate card, most events first', () => {
    assert.deepEqual(listRecentUnpricedModels(SINCE), expected);
  });

  test('reads the window through the event-time index, not every row of a model', () => {
    const { sql, values } = recentUnpricedUsageStatement(SINCE);
    const detail = (getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>)
      .map(r => r.detail).join(' | ');
    assert.match(detail, /SEARCH events USING INDEX idx_events_usage_ts \(<expr>>\?\)/, detail);
  });

  test('/api/health reports them', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json() as { pricing?: { unpriced_models?: unknown } };
    assert.deepEqual(body.pricing?.unpriced_models, expected);
  });

  test('the stats snapshot carries them for the app header', () => {
    assert.deepEqual(statsBroadcastPayload().unpriced_models, expected);
  });
});
