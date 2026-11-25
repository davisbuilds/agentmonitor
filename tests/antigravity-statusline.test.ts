import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let tempDir = '';
let server: Server;
let baseUrl = '';
/* eslint-disable @typescript-eslint/consistent-type-imports */
let getDb: typeof import('../src/db/connection.js').getDb;
let closeDb: typeof import('../src/db/connection.js').closeDb;
let initSchema: typeof import('../src/db/schema.js').initSchema;
let getProviderQuotas: typeof import('../src/db/queries.js').getProviderQuotas;
let getLiveSession: typeof import('../src/db/v2-queries.js').getLiveSession;
let upsertProjectedSessionSnapshot: typeof import('../src/live/projector.js').upsertProjectedSessionSnapshot;
let broadcaster: typeof import('../src/sse/emitter.js').broadcaster;
/* eslint-enable @typescript-eslint/consistent-type-imports */

async function postStatusline(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/provider-quotas/antigravity/statusline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-agr-statusline-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
  process.env.AGENTMONITOR_MAX_SSE_CLIENTS = '4';

  const dbModule = await import('../src/db/connection.js');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  ({ initSchema } = await import('../src/db/schema.js'));
  ({ getProviderQuotas } = await import('../src/db/queries.js'));
  ({ getLiveSession } = await import('../src/db/v2-queries.js'));
  ({ upsertProjectedSessionSnapshot } = await import('../src/live/projector.js'));
  ({ broadcaster } = await import('../src/sse/emitter.js'));
  const { createApp } = await import('../src/app.js');

  initSchema();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  const db = getDb();
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(process.env.AGENTMONITOR_DB_PATH!));
  db.exec('DELETE FROM provider_quotas; DELETE FROM provider_quota_samples; DELETE FROM browsing_sessions;');
});

after(async () => {
  broadcaster?.closeAllClients();
  if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Antigravity statusline bridge', () => {
  test('getProviderQuotas includes antigravity default snapshot', () => {
    const quotas = getProviderQuotas();
    assert.equal(quotas.length, 3);
    const agr = quotas.find(q => q.provider === 'antigravity');
    assert.ok(agr);
    assert.equal(agr.agent_type, 'antigravity');
    assert.equal(agr.status, 'unavailable');
  });

  test('parses live agy statusline quota, strips email/subagents, and updates browsing_sessions occupancy', async () => {
    const payload = {
      cwd: '/Users/example/Dev/sample-project',
      session_id: 'aaaa1111-f064-496b-ba70-c2d0993bc5ee',
      conversation_id: 'aaaa1111-f064-496b-ba70-c2d0993bc5ee',
      conversation_title: 'Configuring Custom Instructions Files',
      model: { id: 'Gemini 4 Neon (High)', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
      workspace: { current_dir: '/Users/example/Dev/sample-project', project_dir: '/Users/example/Dev/sample-project' },
      version: '1.5.15',
      context_window: {
        total_input_tokens: 355910,
        total_output_tokens: 103227,
        context_window_size: 1048576,
        used_percentage: 33.942222595214844,
        remaining_percentage: 66.05777740478516,
        current_usage: {
          input_tokens: 3633,
          output_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 346047,
        },
      },
      exceeds_200k_tokens: true,
      product: 'antigravity',
      quota: {
        '3p-5h': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', reset_in_seconds: 0 },
        '3p-weekly': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', reset_in_seconds: 0 },
        'gemini-5h': { remaining_fraction: 0.9349563, reset_time: '2026-11-26T01:03:36Z', reset_in_seconds: 16280 },
        'gemini-weekly': { remaining_fraction: 0.6907192, reset_time: '2026-12-01T01:03:05Z', reset_in_seconds: 448249 },
      },
      agent_state: 'idle',
      cycle_mode: 'auto',
      plan_tier: 'Google AI Pro',
      email: 'private@example.com',
      subagents: [{ name: 'self', role: 'secret multi-KB prompt', model: 'Gemini 4 Neon', status: 'completed' }],
    };

    const res = await postStatusline(payload);
    assert.equal(res.status, 202);
    const body = await res.json() as { accepted: boolean };
    assert.equal(body.accepted, true);

    const agr = getProviderQuotas().find(q => q.provider === 'antigravity');
    assert.ok(agr);
    assert.equal(agr.agent_type, 'antigravity');
    assert.equal(agr.status, 'available');
    assert.equal(agr.source, 'antigravity-statusline');
    assert.equal(agr.plan_type, 'Google AI Pro');
    assert.equal(agr.account_label, null);
    assert.deepEqual(agr.primary, {
      used_percent: 6.5,
      remaining_percent: 93.5,
      resets_at: '2026-11-26T01:03:36.000Z',
      window_minutes: 300,
    });
    assert.deepEqual(agr.secondary, {
      used_percent: 30.93,
      remaining_percent: 69.07,
      resets_at: '2026-12-01T01:03:05.000Z',
      window_minutes: 10080,
    });

    const rawRow = getDb().prepare('SELECT raw_payload FROM provider_quotas WHERE provider = ?').get('antigravity') as { raw_payload: string };
    const storedRaw = JSON.parse(rawRow.raw_payload) as Record<string, unknown>;
    assert.equal('email' in storedRaw, false, 'email must be stripped from raw_payload');
    assert.equal('subagents' in storedRaw, false, 'subagents must be stripped from raw_payload');
    assert.equal(storedRaw.version, '1.5.15');

    const live = getLiveSession('aaaa1111-f064-496b-ba70-c2d0993bc5ee');
    assert.ok(live);
    assert.equal(live.agent, 'antigravity');
    assert.equal(live.project, 'sample-project');
    assert.equal(live.first_message, 'Configuring Custom Instructions Files');
    assert.equal(live.context_used_tokens, 355910);
    assert.equal(live.context_window_tokens, 1048576);
    assert.equal(live.context_pct, 34);
    assert.equal(live.live_status, 'live');
  });

  test('ignores disabled buckets, handles 3p fallback without epoch-zero reset_time, and clamps used_percent', async () => {
    const res = await postStatusline({
      quota: {
        'gemini-5h': { remaining_fraction: 0.5, reset_time: '2026-11-26T01:00:00Z', reset_in_seconds: 100, disabled: true },
        '3p-5h': { remaining_fraction: 1.2, reset_time: '1970-01-01T00:00:00Z', reset_in_seconds: 0 },
        '3p-weekly': { remaining_fraction: -0.1, reset_time: '2026-12-01T01:00:00Z', reset_in_seconds: 3000 },
      },
      plan_tier: 'Google AI Ultra',
    });
    assert.equal(res.status, 202);

    const agr = getProviderQuotas().find(q => q.provider === 'antigravity');
    assert.ok(agr);
    assert.equal(agr.primary?.used_percent, 0);
    assert.equal(agr.primary?.resets_at, null, 'epoch-zero placeholder reset_time becomes null');
    assert.equal(agr.secondary?.used_percent, 100);
    assert.equal(agr.secondary?.resets_at, '2026-12-01T01:00:00.000Z');
  });

  test('falls back to current_usage sum and does not clobber existing antigravity-sqlite browsing row fields', async () => {
    const sessionId = 'agr-existing-sqlite-1';
    upsertProjectedSessionSnapshot(getDb(), {
      id: sessionId,
      agent: 'antigravity',
      project: 'canonical-proj',
      first_message: 'Original prompt',
      started_at: '2026-11-25T10:00:00.000Z',
      ended_at: '2026-11-25T10:05:00.000Z',
      message_count: 14,
      user_message_count: 3,
      live_status: 'active',
      last_item_at: '2026-11-25T10:05:00.000Z',
    }, {
      integration_mode: 'antigravity-sqlite',
      fidelity: 'summary',
      capabilities: { history: 'summary', search: 'summary', tool_analytics: 'summary', live_items: 'summary' },
    });

    const res = await postStatusline({
      conversation_id: sessionId,
      conversation_title: 'New Statusline Title',
      workspace: { project_dir: '/Users/example/Dev/other-proj' },
      context_window: {
        context_window_size: 1048576,
        current_usage: {
          input_tokens: 4000,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 95000,
        },
      },
    });
    assert.equal(res.status, 202);

    const row = getLiveSession(sessionId);
    assert.ok(row);
    assert.equal(row.integration_mode, 'antigravity-sqlite');
    assert.equal(row.message_count, 14);
    assert.equal(row.user_message_count, 3);
    assert.equal(row.project, 'canonical-proj');
    assert.equal(row.first_message, 'Original prompt');
    assert.equal(row.context_used_tokens, 100000);
    assert.equal(row.context_window_tokens, 1048576);
    assert.equal(row.live_status, 'live');
  });

  test('broadcasts SSE session_update and quota-only payloads work cleanly', async () => {
    const events: string[] = [];
    const fakeRes = {
      writableEnded: false,
      destroyed: false,
      writeHead: () => fakeRes,
      write: (chunk: string) => {
        events.push(chunk);
        return true;
      },
      on: () => fakeRes,
      off: () => fakeRes,
      once: () => fakeRes,
      end: () => {},
    };
    broadcaster.addClient(fakeRes as unknown as Parameters<typeof broadcaster.addClient>[0]);
    try {
      const res = await postStatusline({
        session_id: 'agr-sse-1',
        context_window: {
          total_input_tokens: 42000,
          context_window_size: 1048576,
        },
        quota: {
          'gemini-5h': { remaining_fraction: 0.9, reset_time: '2026-11-26T02:00:00Z', reset_in_seconds: 3600 },
        },
      });
      assert.equal(res.status, 202);
      assert.ok(events.some(chunk => chunk.includes('"type":"session_update"') && chunk.includes('"session_parsed"') && chunk.includes('agr-sse-1')));

      const usageMonitorRes = await fetch(`${baseUrl}/api/stats/usage-monitor`);
      assert.equal(usageMonitorRes.status, 200);
      const usageMonitor = await usageMonitorRes.json() as Array<Record<string, unknown>>;
      const agrUsage = usageMonitor.find(row => row.provider === 'antigravity');
      assert.ok(agrUsage);
      assert.equal(agrUsage.agent_type, 'antigravity');
      assert.equal(agrUsage.status, 'available');

      const badRes = await postStatusline({ hello: 'world' });
      assert.equal(badRes.status, 202);
      const badJson = await badRes.json() as { accepted: boolean };
      assert.equal(badJson.accepted, false);
    } finally {
      broadcaster.closeAllClients();
    }
  });
});
