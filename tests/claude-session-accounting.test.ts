import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Isolate the DB before importing any module that resolves the connection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-session-accounting-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'agentmonitor.db');
process.env.AGENTMONITOR_MAX_SSE_CLIENTS = '0';

const { initSchema } = await import('../src/db/schema.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { createApp } = await import('../src/app.js');
const { checkClaudeSessionCosts } = await import('../src/db/queries.js');

let server: Server;
let baseUrl = '';

function statusline(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/provider-quotas/claude/statusline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function seedEvent(sessionId: string, at: string, cost: number, source = 'import'): void {
  getDb().prepare(`
    INSERT INTO events (session_id, agent_type, event_type, status, tokens_in, tokens_out,
      cost_usd, source, client_timestamp)
    VALUES (?, 'claude_code', 'llm_response', 'success', 1, 1, ?, ?, ?)
  `).run(sessionId, cost, source, at);
}

describe('Claude session accounting', () => {
  before(async () => {
    initSchema();
    server = createApp().listen(0);
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    assert.equal(getDb().name, process.env.AGENTMONITOR_DB_PATH);
    getDb().exec('DELETE FROM claude_session_accounting; DELETE FROM events;');
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('records the running cost a statusline payload reports, even without rate limits', async () => {
    const before = Date.now();
    const res = await statusline({
      session_id: 'sess-a',
      version: '2.1.280',
      cost: { total_cost_usd: 12.5, total_duration_ms: 3_600_000 },
    });
    assert.equal(res.status, 202);

    const [check] = checkClaudeSessionCosts();
    assert.equal(check.session_id, 'sess-a');
    assert.equal(check.cost_usd, 12.5);
    assert.equal(check.claude_version, '2.1.280');
    const observed = Date.parse(check.observed_at);
    assert.ok(observed >= before && observed <= Date.now());
    assert.equal(observed - Date.parse(check.process_started_at), 3_600_000,
      'the totals cover the process, which started total_duration_ms earlier');
  });

  test('keeps the latest totals per session', async () => {
    await statusline({ session_id: 'sess-b', cost: { total_cost_usd: 1, total_duration_ms: 1000 } });
    await new Promise(resolve => setTimeout(resolve, 5));
    const secondSent = Date.now();
    await statusline({ session_id: 'sess-b', cost: { total_cost_usd: 2, total_duration_ms: 2000 } });
    await statusline({ session_id: 'sess-c', cost: { total_cost_usd: 5, total_duration_ms: 1000 } });

    const checks = checkClaudeSessionCosts();
    const bySession = Object.fromEntries(checks.map(check => [check.session_id, check.cost_usd]));
    assert.deepEqual(bySession, { 'sess-b': 2, 'sess-c': 5 });
    const latest = checks.find(check => check.session_id === 'sess-b');
    assert.ok(latest && Date.parse(latest.observed_at) >= secondSent, 'the window ends at the latest observation');
  });

  test('a sample arriving late does not replace a newer one from the same process', async () => {
    // The bridge posts in the background, so samples can arrive out of order:
    // here a sample read half a second earlier lands after the newer one.
    await statusline({ session_id: 'sess-late', cost: { total_cost_usd: 2, total_duration_ms: 2_000_000 } });
    await statusline({ session_id: 'sess-late', cost: { total_cost_usd: 1, total_duration_ms: 1_999_500 } });

    const [check] = checkClaudeSessionCosts();
    assert.equal(check.cost_usd, 2);
  });

  test('a new process for the same session replaces the old totals', async () => {
    // A restarted or resumed session starts its counters again from zero.
    await statusline({ session_id: 'sess-restart', cost: { total_cost_usd: 50, total_duration_ms: 3_600_000 } });
    await statusline({ session_id: 'sess-restart', cost: { total_cost_usd: 0.5, total_duration_ms: 1000 } });

    const [check] = checkClaudeSessionCosts();
    assert.equal(check.cost_usd, 0.5);
  });

  test('a late sample from the process before a restart is dropped', async () => {
    // The old process's last sample can still be in flight when the new one
    // reports. Its longer duration must not win: it belongs to an older process.
    await statusline({ session_id: 'sess-late-old', cost: { total_cost_usd: 0.5, total_duration_ms: 1000 } });
    await statusline({ session_id: 'sess-late-old', cost: { total_cost_usd: 50, total_duration_ms: 3_600_000 } });
    assert.equal(checkClaudeSessionCosts()[0].cost_usd, 0.5);

    await statusline({ session_id: 'sess-late-old', cost: { total_cost_usd: 0.7, total_duration_ms: 2000 } });
    assert.equal(checkClaudeSessionCosts()[0].cost_usd, 0.7, 'the new process keeps reporting');
  });

  test('ignores payloads without a session or a cost', async () => {
    await statusline({ cost: { total_cost_usd: 1, total_duration_ms: 1000 } });
    await statusline({ session_id: 'sess-d' });
    await statusline({ session_id: 'sess-d', cost: { total_cost_usd: 'lots', total_duration_ms: 1000 } });
    assert.deepEqual(checkClaudeSessionCosts(), []);
  });

  test('compares amon\'s imported cost for the session over the same window', async () => {
    await statusline({ session_id: 'sess-e', cost: { total_cost_usd: 10, total_duration_ms: 3_600_000 } });
    const [{ process_started_at: start, observed_at: observed }] = checkClaudeSessionCosts();
    const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
    seedEvent('sess-e', shift(start, 60_000), 4);
    seedEvent('sess-e', shift(observed, -60_000), 5);
    seedEvent('sess-e', shift(start, -60_000), 100); // an earlier process of the same session
    seedEvent('sess-e', shift(observed, 60_000), 100); // after the totals were read
    seedEvent('sess-other', shift(start, 60_000), 100);
    seedEvent('sess-e', shift(start, 60_000), 100, 'otel'); // not an import; the check tests imports

    const [check] = checkClaudeSessionCosts();

    assert.equal(check.amon_cost_usd, 9);
    assert.equal(check.unpriced_rows, 0);
    assert.equal(check.ratio, 0.9);
  });

  test('gives no ratio while any imported usage in the window is unpriced', async () => {
    // An unpriced model bills as NULL, which a sum silently skips, so the
    // imported cost would read low and the ratio falsely reassuring.
    await statusline({ session_id: 'sess-f', cost: { total_cost_usd: 10, total_duration_ms: 3_600_000 } });
    const [{ process_started_at: start }] = checkClaudeSessionCosts();
    const at = new Date(Date.parse(start) + 60_000).toISOString();
    seedEvent('sess-f', at, 9);
    getDb().prepare(`
      INSERT INTO events (session_id, agent_type, event_type, status, tokens_in, tokens_out, cost_usd, source, client_timestamp)
      VALUES ('sess-f', 'claude_code', 'llm_response', 'success', 5, 5, NULL, 'import', ?)
    `).run(at);
    getDb().prepare(`
      INSERT INTO events (session_id, agent_type, event_type, status, tokens_in, tokens_out, cost_usd, source, client_timestamp)
      VALUES ('sess-f', 'claude_code', 'user', 'success', 0, 0, NULL, 'import', ?)
    `).run(at); // no usage, so nothing to price

    const [check] = checkClaudeSessionCosts();

    assert.equal(check.unpriced_rows, 1);
    assert.equal(check.ratio, null);
  });
});
