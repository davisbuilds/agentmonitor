import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl = '';
let tempDir = '';
let getDb: (() => { exec: (sql: string) => void }) | null = null;
let closeDb: (() => void) | null = null;

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentstats-dash-test-'));
  process.env.AGENTSTATS_DB_PATH = path.join(tempDir, 'agentstats-dash-test.db');
  process.env.AGENTSTATS_MAX_PAYLOAD_KB = '64';
  process.env.AGENTSTATS_MAX_SSE_CLIENTS = '0';

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  const { createApp } = await import('../src/app.js');

  getDb = dbModule.getDb as () => { exec: (sql: string) => void };
  closeDb = dbModule.closeDb as () => void;

  initSchema();
  server = createApp({ serveStatic: false }).listen(0);
  await once(server, 'listening');

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') throw new Error('Server failed to start');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  if (!getDb) throw new Error('DB not initialized');
  getDb().exec('DELETE FROM events; DELETE FROM sessions; DELETE FROM agents;');
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  closeDb?.();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

// Seed some test events for analytics queries
async function seedTestData() {
  const events = [
    { session_id: 's1', agent_type: 'claude_code', event_type: 'tool_use', tool_name: 'Bash', status: 'success', tokens_in: 1000, tokens_out: 200, model: 'claude-sonnet-4-5-20250929', cost_usd: 0.01, duration_ms: 150 },
    { session_id: 's1', agent_type: 'claude_code', event_type: 'tool_use', tool_name: 'Bash', status: 'error', tokens_in: 500, tokens_out: 100, model: 'claude-sonnet-4-5-20250929', cost_usd: 0.005, duration_ms: 200 },
    { session_id: 's1', agent_type: 'claude_code', event_type: 'tool_use', tool_name: 'Read', status: 'success', tokens_in: 800, tokens_out: 300, model: 'claude-sonnet-4-5-20250929', cost_usd: 0.008, duration_ms: 50 },
    { session_id: 's1', agent_type: 'claude_code', event_type: 'response', status: 'success', tokens_in: 2000, tokens_out: 1000, model: 'claude-sonnet-4-5-20250929', cost_usd: 0.02 },
    { session_id: 's2', agent_type: 'codex', event_type: 'tool_use', tool_name: 'Bash', status: 'success', tokens_in: 600, tokens_out: 150, model: 'o3', cost_usd: 0.015, duration_ms: 300 },
    { session_id: 's2', agent_type: 'codex', event_type: 'tool_use', tool_name: 'Edit', status: 'success', tokens_in: 400, tokens_out: 100, model: 'o3', cost_usd: 0.01, duration_ms: 80 },
  ];

  const res = await postJson(`${baseUrl}/api/events/batch`, { events });
  assert.ok(res.status >= 200 && res.status < 300, `batch ingest failed: ${res.status}`);
}

// ─── Tool Analytics API ─────────────────────────────────────────────────

describe('GET /api/stats/tools', () => {
  test('returns tool analytics with frequency, error rate, avg duration', async () => {
    await seedTestData();

    const res = await fetch(`${baseUrl}/api/stats/tools`);
    assert.equal(res.status, 200);

    const body = await res.json() as { tools: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.tools));
    assert.ok(body.tools.length >= 3); // Bash, Read, Edit

    // Find Bash - should have highest call count
    const bash = body.tools.find(t => t.tool_name === 'Bash');
    assert.ok(bash);
    assert.equal(bash.total_calls, 3); // 2 claude + 1 codex
    assert.equal(bash.error_count, 1);
    assert.ok((bash.error_rate as number) > 0);
    assert.ok(bash.avg_duration_ms != null);

    // Verify by_agent breakdown
    const byAgent = bash.by_agent as Record<string, number>;
    assert.equal(byAgent.claude_code, 2);
    assert.equal(byAgent.codex, 1);
  });

  test('filters by agent_type', async () => {
    await seedTestData();

    const res = await fetch(`${baseUrl}/api/stats/tools?agent_type=codex`);
    const body = await res.json() as { tools: Array<Record<string, unknown>> };

    // Only codex tools
    assert.ok(body.tools.every(t => {
      const byAgent = t.by_agent as Record<string, number>;
      return byAgent.codex !== undefined;
    }));
  });

  test('returns empty array when no tool events', async () => {
    const res = await fetch(`${baseUrl}/api/stats/tools`);
    const body = await res.json() as { tools: Array<Record<string, unknown>> };
    assert.deepEqual(body.tools, []);
  });
});

// ─── Cost API ───────────────────────────────────────────────────────────

describe('GET /api/stats/cost', () => {
  test('returns cost breakdowns by model, session, and timeline', async () => {
    await seedTestData();

    const res = await fetch(`${baseUrl}/api/stats/cost`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      by_model: Array<Record<string, unknown>>;
      by_session: Array<Record<string, unknown>>;
      timeline: Array<Record<string, unknown>>;
    };

    // by_model
    assert.ok(Array.isArray(body.by_model));
    assert.ok(body.by_model.length >= 2); // claude-sonnet and o3
    const sonnet = body.by_model.find(m => m.model === 'claude-sonnet-4-5-20250929');
    assert.ok(sonnet);
    assert.ok((sonnet.cost_usd as number) > 0);

    // by_session
    assert.ok(Array.isArray(body.by_session));
    assert.ok(body.by_session.length >= 2); // s1 and s2

    // timeline
    assert.ok(Array.isArray(body.timeline));
    assert.ok(body.timeline.length >= 1);
    assert.ok(body.timeline[0].bucket);
    assert.ok((body.timeline[0].cost_usd as number) > 0);
  });

  test('returns empty arrays when no cost data', async () => {
    const res = await fetch(`${baseUrl}/api/stats/cost`);
    const body = await res.json() as {
      by_model: unknown[];
      by_session: unknown[];
      timeline: unknown[];
    };
    assert.deepEqual(body.by_model, []);
    assert.deepEqual(body.by_session, []);
    assert.deepEqual(body.timeline, []);
  });

  test('respects agent_type filter', async () => {
    await seedTestData();

    const res = await fetch(`${baseUrl}/api/stats/cost?agent_type=codex`);
    const body = await res.json() as { timeline: Array<Record<string, unknown>> };

    // Timeline should only have codex events
    const totalCost = body.timeline.reduce((sum, b) => sum + (b.cost_usd as number), 0);
    // Codex events total: 0.015 + 0.01 = 0.025
    assert.ok(totalCost > 0);
    assert.ok(totalCost < 0.03); // Should not include claude events
  });
});

// ─── Filter Options (existing, verify still works) ──────────────────────

describe('GET /api/filter-options', () => {
  test('returns distinct filter values from events', async () => {
    await seedTestData();

    const res = await fetch(`${baseUrl}/api/filter-options`);
    assert.equal(res.status, 200);

    const body = await res.json() as Record<string, string[]>;
    assert.ok(body.agent_types.includes('claude_code'));
    assert.ok(body.agent_types.includes('codex'));
    assert.ok(body.tool_names.includes('Bash'));
    assert.ok(body.tool_names.includes('Read'));
    assert.ok(body.models.includes('claude-sonnet-4-5-20250929'));
    assert.ok(body.models.includes('o3'));
  });
});
