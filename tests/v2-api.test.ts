import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before, after, describe } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl = '';
let tempDir = '';
let closeDb: (() => void) | null = null;

// Sample session data to seed into the DB
function sampleJsonl(lines: object[]): string {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

function makeSession(sessionId: string, project: string, msgCount: number, startDate: string) {
  const lines: object[] = [];
  for (let i = 0; i < msgCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const ts = new Date(new Date(startDate).getTime() + i * 60_000).toISOString();
    if (role === 'user') {
      lines.push({
        type: 'user',
        parentUuid: i === 0 ? null : `uuid-${i - 1}`,
        sessionId,
        cwd: `/Users/dev/${project}`,
        message: { role: 'user', content: [{ type: 'text', text: `User message ${i} for ${project}` }] },
        timestamp: ts,
      });
    } else {
      const content: object[] = [{ type: 'text', text: `Assistant response ${i}` }];
      if (i === 1) {
        content.push({
          type: 'tool_use',
          id: `toolu_${sessionId}_${i}`,
          name: 'Read',
          input: { file_path: `/Users/dev/${project}/src/index.ts` },
        });
      }
      if (i === 3) {
        content.unshift({ type: 'thinking', thinking: 'Let me consider this...' });
        content.push({
          type: 'tool_use',
          id: `toolu_${sessionId}_${i}`,
          name: 'Bash',
          input: { command: 'npm test' },
        });
      }
      lines.push({
        type: 'assistant',
        parentUuid: `uuid-${i - 1}`,
        sessionId,
        cwd: `/Users/dev/${project}`,
        message: { role: 'assistant', model: 'claude-opus-4-6', content },
        timestamp: ts,
      });
    }
  }
  return sampleJsonl(lines);
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-v2-api-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  closeDb = dbModule.closeDb;
  initSchema();

  // Seed test data via parser
  const { parseSessionMessages, insertParsedSession } = await import('../src/parser/claude-code.js');
  const { syncClaudeLiveSession } = await import('../src/live/claude-adapter.js');
  const db = dbModule.getDb();

  // Create 5 sessions across 3 projects with varying sizes
  const sessions = [
    { id: 'api-sess-001', project: 'alpha', msgs: 10, date: '2026-03-01T10:00:00Z' },
    { id: 'api-sess-002', project: 'alpha', msgs: 6, date: '2026-03-02T14:00:00Z' },
    { id: 'api-sess-003', project: 'beta', msgs: 20, date: '2026-03-03T09:00:00Z' },
    { id: 'api-sess-004', project: 'gamma', msgs: 4, date: '2026-03-04T16:00:00Z' },
    { id: 'api-sess-005', project: 'beta', msgs: 8, date: '2026-03-05T11:00:00Z' },
    { id: 'api-tie-001', project: 'tie', msgs: 4, date: '2026-03-06T09:00:00Z' },
    { id: 'api-tie-002', project: 'tie', msgs: 4, date: '2026-03-06T09:00:00Z' },
    { id: 'api-tie-003', project: 'tie', msgs: 4, date: '2026-03-06T09:00:00Z' },
  ];

  for (const s of sessions) {
    const jsonl = makeSession(s.id, s.project, s.msgs, s.date);
    const filePath = `/fake/projects/-Users-dev-Dev-${s.project}/${s.id}.jsonl`;
    const parsed = parseSessionMessages(jsonl, s.id, filePath);
    insertParsedSession(db, parsed, filePath, 1024, `hash_${s.id}`);
    syncClaudeLiveSession(db, parsed);
  }

  // Add a child session for relationship testing
  const childJsonl = makeSession('api-sess-006', 'alpha', 4, '2026-03-01T11:00:00Z');
  const childParsed = parseSessionMessages(childJsonl, 'api-sess-006');
  // Manually set parent relationship
  childParsed.metadata.parent_session_id = 'api-sess-001';
  childParsed.metadata.relationship_type = 'subagent';
  insertParsedSession(db, childParsed, '/fake/api-sess-006.jsonl', 512, 'hash_006');
  syncClaudeLiveSession(db, childParsed);

  // Start server
  const { createApp } = await import('../src/app.js');
  const app = createApp({ serveStatic: false });
  server = app.listen(0);
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  server.close();
  if (closeDb) closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// --- Sessions endpoints ---

describe('GET /api/v2/sessions', () => {
  test('returns paginated session list', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: unknown[]; total: number };
    assert.ok(body.data.length >= 5, `expected >= 5 sessions, got ${body.data.length}`);
    assert.ok(body.total >= 5);
  });

  test('respects limit parameter', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?limit=2`);
    const body = await res.json() as { data: unknown[]; cursor?: string };
    assert.equal(body.data.length, 2);
    assert.ok(body.cursor, 'should return cursor for pagination');
  });

  test('cursor pagination returns next page', async () => {
    const res1 = await fetch(`${baseUrl}/api/v2/sessions?limit=2`);
    const body1 = await res1.json() as { data: Array<{ id: string }>; cursor: string };

    const res2 = await fetch(`${baseUrl}/api/v2/sessions?limit=2&cursor=${body1.cursor}`);
    const body2 = await res2.json() as { data: Array<{ id: string }> };

    // Pages should not overlap
    const ids1 = new Set(body1.data.map(s => s.id));
    for (const s of body2.data) {
      assert.ok(!ids1.has(s.id), `session ${s.id} should not appear in both pages`);
    }
  });

  test('cursor pagination remains stable when sessions share the same started_at', async () => {
    const res1 = await fetch(`${baseUrl}/api/v2/sessions?project=tie&limit=2`);
    assert.equal(res1.status, 200);
    const body1 = await res1.json() as { data: Array<{ id: string }>; cursor?: string };
    assert.deepEqual(body1.data.map(session => session.id), ['api-tie-003', 'api-tie-002']);
    assert.ok(body1.cursor);

    const res2 = await fetch(`${baseUrl}/api/v2/sessions?project=tie&limit=2&cursor=${body1.cursor}`);
    assert.equal(res2.status, 200);
    const body2 = await res2.json() as { data: Array<{ id: string }> };
    assert.deepEqual(body2.data.map(session => session.id), ['api-tie-001']);
  });

  test('filters by project', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?project=alpha`);
    const body = await res.json() as { data: Array<{ project: string }> };
    assert.ok(body.data.length >= 2);
    for (const s of body.data) {
      assert.equal(s.project, 'alpha');
    }
  });

  test('filters by date range', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?date_from=2026-03-03&date_to=2026-03-04`);
    const body = await res.json() as { data: Array<{ started_at: string }> };
    for (const s of body.data) {
      const d = new Date(s.started_at);
      assert.ok(d >= new Date('2026-03-03'), 'should be after date_from');
      assert.ok(d < new Date('2026-03-05'), 'should be before date_to + 1 day');
    }
  });

  test('filters by min_messages', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?min_messages=10`);
    const body = await res.json() as { data: Array<{ message_count: number }> };
    for (const s of body.data) {
      assert.ok(s.message_count >= 10, `expected >= 10 messages, got ${s.message_count}`);
    }
  });

  test('filters by max_messages', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?max_messages=6`);
    const body = await res.json() as { data: Array<{ message_count: number }> };
    assert.ok(body.data.length > 0, 'should have results');
    for (const s of body.data) {
      assert.ok(s.message_count <= 6, `expected <= 6 messages, got ${s.message_count}`);
    }
  });

  test('handles invalid limit gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?limit=notanumber`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: unknown[] };
    assert.ok(body.data.length > 0, 'should fall back to default limit');
  });

  test('handles invalid min_messages gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?min_messages=abc`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: unknown[] };
    assert.ok(body.data.length > 0, 'should ignore invalid min_messages');
  });

  test('filters by agent', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions?agent=claude`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ agent: string }> };
    for (const s of body.data) {
      assert.equal(s.agent, 'claude');
    }
  });

  test('returns sessions ordered by started_at DESC', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions`);
    const body = await res.json() as { data: Array<{ started_at: string }> };
    for (let i = 1; i < body.data.length; i++) {
      assert.ok(body.data[i - 1].started_at >= body.data[i].started_at,
        'sessions should be ordered by started_at DESC');
    }
  });
});

describe('GET /api/v2/sessions/:id', () => {
  test('returns session detail', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-001`);
    assert.equal(res.status, 200);
    const body = await res.json() as { id: string; project: string; message_count: number };
    assert.equal(body.id, 'api-sess-001');
    assert.equal(body.project, 'alpha');
    assert.equal(body.message_count, 10);
  });

  test('returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/nonexistent`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/v2/sessions/:id/messages', () => {
  test('returns messages in ordinal order', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/messages`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ ordinal: number; role: string }>; total: number };
    assert.equal(body.total, 20);
    for (let i = 1; i < body.data.length; i++) {
      assert.ok(body.data[i].ordinal > body.data[i - 1].ordinal);
    }
  });

  test('supports offset and limit pagination', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-003/messages?offset=5&limit=3`);
    const body = await res.json() as { data: Array<{ ordinal: number }>; total: number };
    assert.equal(body.data.length, 3);
    assert.equal(body.data[0].ordinal, 5);
    assert.equal(body.total, 20);
  });

  test('returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/nonexistent/messages`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/v2/sessions/:id/children', () => {
  test('returns child sessions', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-001/children`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ id: string; relationship_type: string }> };
    assert.ok(body.data.length >= 1);
    assert.ok(body.data.some(s => s.id === 'api-sess-006'));
  });

  test('returns empty array for session with no children', async () => {
    const res = await fetch(`${baseUrl}/api/v2/sessions/api-sess-004/children`);
    const body = await res.json() as { data: unknown[] };
    assert.equal(body.data.length, 0);
  });
});

// --- Live endpoints ---

describe('GET /api/v2/live/settings', () => {
  test('returns live settings and capture metadata', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/settings`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      enabled: boolean;
      codex_mode: string;
      capture: { prompts: boolean; reasoning: boolean; tool_arguments: boolean };
      diff_payload_max_bytes: number;
    };
    assert.equal(typeof body.enabled, 'boolean');
    assert.equal(body.codex_mode, 'otel-only');
    assert.equal(typeof body.capture.prompts, 'boolean');
    assert.equal(typeof body.capture.reasoning, 'boolean');
    assert.equal(typeof body.capture.tool_arguments, 'boolean');
    assert.equal(typeof body.diff_payload_max_bytes, 'number');
  });
});

describe('GET /api/v2/live/sessions', () => {
  test('returns live sessions with fidelity metadata', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      data: Array<{
        id: string;
        integration_mode: string | null;
        fidelity: string | null;
        capabilities: { history: string; search: string; tool_analytics: string; live_items: string } | null;
      }>;
      total: number;
    };
    assert.ok(body.data.length >= 6);
    assert.ok(body.total >= 6);
    assert.ok(body.data.some(session => session.integration_mode === 'claude-jsonl'));
    assert.ok(body.data.some(session => session.fidelity === 'full'));
    const claudeSession = body.data.find(session => session.integration_mode === 'claude-jsonl');
    assert.deepEqual(claudeSession?.capabilities, {
      history: 'full',
      search: 'full',
      tool_analytics: 'full',
      live_items: 'full',
    });
  });

  test('filters live sessions by agent and live_status', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions?agent=claude&live_status=ended`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ agent: string; live_status: string | null }> };
    assert.ok(body.data.length > 0);
    for (const session of body.data) {
      assert.equal(session.agent, 'claude');
      assert.equal(session.live_status, 'ended');
    }
  });

  test('live session pagination remains stable when sessions share the same sort timestamp', async () => {
    const res1 = await fetch(`${baseUrl}/api/v2/live/sessions?project=tie&limit=2`);
    assert.equal(res1.status, 200);
    const body1 = await res1.json() as { data: Array<{ id: string }>; cursor?: string };
    assert.deepEqual(body1.data.map(session => session.id), ['api-tie-003', 'api-tie-002']);
    assert.ok(body1.cursor);

    const res2 = await fetch(`${baseUrl}/api/v2/live/sessions?project=tie&limit=2&cursor=${body1.cursor}`);
    assert.equal(res2.status, 200);
    const body2 = await res2.json() as { data: Array<{ id: string }> };
    assert.deepEqual(body2.data.map(session => session.id), ['api-tie-001']);
  });
});

describe('GET /api/v2/live/sessions/:id', () => {
  test('returns live session detail', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-001`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      id: string;
      integration_mode: string | null;
      fidelity: string | null;
      capabilities: { history: string; search: string; tool_analytics: string; live_items: string } | null;
    };
    assert.equal(body.id, 'api-sess-001');
    assert.equal(body.integration_mode, 'claude-jsonl');
    assert.equal(body.fidelity, 'full');
    assert.deepEqual(body.capabilities, {
      history: 'full',
      search: 'full',
      tool_analytics: 'full',
      live_items: 'full',
    });
  });

  test('returns 404 for missing live session', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions/missing-live-session`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/v2/live/sessions/:id/turns', () => {
  test('returns live turns for a session', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-001/turns`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ session_id: string; source_turn_id: string }> };
    assert.ok(body.data.length > 0);
    assert.equal(body.data[0].session_id, 'api-sess-001');
    assert.ok(body.data[0].source_turn_id.startsWith('claude-message:'));
  });
});

describe('GET /api/v2/live/sessions/:id/items', () => {
  test('returns live items in ascending id order', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-001/items`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ id: number; kind: string }>; total: number };
    assert.ok(body.data.length > 0);
    assert.ok(body.total >= body.data.length);
    for (let i = 1; i < body.data.length; i++) {
      assert.ok(body.data[i].id > body.data[i - 1].id);
    }
  });

  test('filters live items by kind', async () => {
    const res = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-003/items?kinds=reasoning`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ kind: string }> };
    assert.ok(body.data.length > 0);
    for (const item of body.data) {
      assert.equal(item.kind, 'reasoning');
    }
  });

  test('supports cursor pagination for live items', async () => {
    const first = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-003/items?limit=2`);
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { data: Array<{ id: number }>; cursor?: string };
    assert.equal(firstBody.data.length, 2);
    assert.ok(firstBody.cursor);

    const second = await fetch(`${baseUrl}/api/v2/live/sessions/api-sess-003/items?limit=2&cursor=${firstBody.cursor}`);
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { data: Array<{ id: number }> };
    assert.ok(secondBody.data.length > 0);
    assert.ok(secondBody.data[0].id > firstBody.data[firstBody.data.length - 1].id);
  });
});

// --- Search endpoint ---

describe('GET /api/v2/search', () => {
  test('returns matching results for FTS query', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=alpha`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ session_id: string; snippet: string }> };
    assert.ok(body.data.length > 0, 'should find results for "alpha"');
  });

  test('returns 400 without query parameter', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search`);
    assert.equal(res.status, 400);
  });

  test('filters search by project', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=message&project=gamma`);
    const body = await res.json() as { data: Array<{ session_id: string }> };
    // All results should be from gamma project sessions
    for (const r of body.data) {
      assert.equal(r.session_id, 'api-sess-004', 'should only return gamma sessions');
    }
  });

  test('respects limit parameter', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=message&limit=3`);
    const body = await res.json() as { data: unknown[] };
    assert.ok(body.data.length <= 3);
  });

  test('includes snippet with match context', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=Assistant`);
    const body = await res.json() as { data: Array<{ snippet: string }> };
    if (body.data.length > 0) {
      assert.ok(body.data[0].snippet, 'should include snippet');
    }
  });

  test('returns 400 for invalid FTS5 syntax', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=${encodeURIComponent('"unclosed')}`);
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('syntax'), 'error should mention syntax');
  });

  test('cursor pagination returns next page without overlap', async () => {
    const res1 = await fetch(`${baseUrl}/api/v2/search?q=message&limit=3`);
    const body1 = await res1.json() as { data: Array<{ message_id: number }>; cursor?: string };

    if (body1.cursor) {
      const res2 = await fetch(`${baseUrl}/api/v2/search?q=message&limit=3&cursor=${body1.cursor}`);
      const body2 = await res2.json() as { data: Array<{ message_id: number }> };

      const ids1 = new Set(body1.data.map(r => r.message_id));
      for (const r of body2.data) {
        assert.ok(!ids1.has(r.message_id), `message_id ${r.message_id} should not appear in both pages`);
      }
    }
  });

  test('filters search by agent', async () => {
    const res = await fetch(`${baseUrl}/api/v2/search?q=message&agent=claude`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: unknown[] };
    assert.ok(Array.isArray(body.data));
  });
});

// --- Analytics endpoints ---

describe('GET /api/v2/analytics/summary', () => {
  test('returns correct totals', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/summary`);
    assert.equal(res.status, 200);
    const body = await res.json() as { total_sessions: number; total_messages: number; daily_average_sessions: number; date_range: { earliest: string | null; latest: string | null } };
    assert.ok(body.total_sessions >= 6, `expected >= 6 sessions, got ${body.total_sessions}`);
    assert.ok(body.total_messages > 0);
    assert.ok(typeof body.daily_average_sessions === 'number');
    assert.ok(body.date_range.earliest);
    assert.ok(body.date_range.latest);
  });

  test('filters summary by project', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/summary?project=alpha`);
    assert.equal(res.status, 200);
    const body = await res.json() as { total_sessions: number };
    // Alpha has 2 sessions + 1 child = 3
    assert.ok(body.total_sessions >= 2 && body.total_sessions <= 4, `expected 2-4 alpha sessions, got ${body.total_sessions}`);
  });

  test('filters summary by date range', async () => {
    const all = await fetch(`${baseUrl}/api/v2/analytics/summary`);
    const allBody = await all.json() as { total_sessions: number };

    const filtered = await fetch(`${baseUrl}/api/v2/analytics/summary?date_from=2026-03-04`);
    const filteredBody = await filtered.json() as { total_sessions: number };
    assert.ok(filteredBody.total_sessions < allBody.total_sessions, 'filtered should have fewer sessions');
  });
});

describe('GET /api/v2/analytics/activity', () => {
  test('returns daily activity data', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/activity`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ date: string; sessions: number; messages: number }> };
    assert.ok(body.data.length > 0);
    for (const point of body.data) {
      assert.ok(point.date, 'should have date');
      assert.ok(typeof point.sessions === 'number');
      assert.ok(typeof point.messages === 'number');
    }
  });

  test('filters by date range', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/activity?date_from=2026-03-03&date_to=2026-03-05`);
    const body = await res.json() as { data: Array<{ date: string }> };
    for (const point of body.data) {
      assert.ok(point.date >= '2026-03-03');
      assert.ok(point.date <= '2026-03-05');
    }
  });

  test('filters by project', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/activity?project=beta`);
    const body = await res.json() as { data: Array<{ sessions: number }> };
    assert.ok(body.data.length > 0);
  });
});

describe('GET /api/v2/analytics/projects', () => {
  test('returns per-project breakdown', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/projects`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ project: string; session_count: number; message_count: number }> };
    assert.ok(body.data.length >= 3, 'should have at least 3 projects');
    for (const p of body.data) {
      assert.ok(p.project);
      assert.ok(p.session_count > 0);
      assert.ok(p.message_count > 0);
    }
  });
});

describe('GET /api/v2/analytics/tools', () => {
  test('returns tool usage stats', async () => {
    const res = await fetch(`${baseUrl}/api/v2/analytics/tools`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ tool_name: string; category: string; count: number }> };
    assert.ok(body.data.length > 0, 'should have tool usage data');
    // We know Read and Bash were inserted
    assert.ok(body.data.some(t => t.tool_name === 'Read'));
  });
});

// --- Metadata endpoints ---

describe('GET /api/v2/projects', () => {
  test('returns distinct project names', async () => {
    const res = await fetch(`${baseUrl}/api/v2/projects`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: string[] };
    assert.ok(body.data.includes('alpha'));
    assert.ok(body.data.includes('beta'));
    assert.ok(body.data.includes('gamma'));
  });
});

describe('GET /api/v2/agents', () => {
  test('returns distinct agent types', async () => {
    const res = await fetch(`${baseUrl}/api/v2/agents`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data: string[] };
    assert.ok(body.data.includes('claude'));
  });
});

// --- Regression: existing API still works ---

describe('existing API regression', () => {
  test('GET /api/health still works', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'ok');
  });

  test('GET /api/events still works', async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: unknown[] };
    assert.ok(Array.isArray(body.events));
  });
});
