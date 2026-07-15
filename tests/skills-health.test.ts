import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import type { SkillHealthRow } from '../src/api/v2/types.ts';

let db: Database;
let closeDb: () => void;
let getAnalyticsSkillsDaily: (params?: Record<string, unknown>) => Array<{
  date: string;
  total: number;
  skills: Array<{ skill_name: string; count: number }>;
}>;
let getAnalyticsSkillsHealth: (params?: Record<string, unknown>) => SkillHealthRow[];
let server: Server;
let baseUrl: string;

function makeCatalogSkill(root: string, name: string, version: string | null): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = version ? `name: ${name}\nversion: ${version}` : `name: ${name}`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${name}\n`);
}

function insertSession(id: string, agent: string, integrationMode: string | null = null): void {
  db.prepare(
    `INSERT INTO browsing_sessions (id, agent, project, started_at, integration_mode)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, agent, 'proj', '2026-07-01T09:00:00Z', integrationMode);
}

function insertMessage(sessionId: string, ordinal: number, role: string, content: string, timestamp: string): number {
  const info = db.prepare(
    `INSERT INTO messages (session_id, ordinal, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, ordinal, role, content, timestamp);
  return Number(info.lastInsertRowid);
}

function insertToolCall(messageId: number, sessionId: string, toolName: string, inputJson: string): void {
  db.prepare(
    `INSERT INTO tool_calls (message_id, session_id, tool_name, input_json) VALUES (?, ?, ?, ?)`,
  ).run(messageId, sessionId, toolName, inputJson);
}

function insertSnapshot(name: string, version: string | null, first: string, last: string): void {
  db.prepare(
    `INSERT INTO skill_catalog_snapshots (name, version, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)`,
  ).run(name, version, first, last);
}

const skillCall = (skill: string) =>
  JSON.stringify([{ type: 'tool_use', name: 'Skill', input: { skill } }]);
const toolResult = (body: string) =>
  JSON.stringify([{ type: 'tool_result', tool_use_id: 'x', content: body }]);
const userText = (text: string) => JSON.stringify([{ type: 'text', text }]);

/** An explicit Skill invocation followed by its tool_result and then a final user turn. */
function seedInvocation(
  sessionId: string,
  skill: string,
  finalUserContent: string,
  ts = '2026-07-01T10:00:00Z',
): void {
  insertSession(sessionId, 'claude');
  const msgId = insertMessage(sessionId, 0, 'assistant', skillCall(skill), ts);
  insertToolCall(msgId, sessionId, 'Skill', JSON.stringify({ skill }));
  insertMessage(sessionId, 1, 'user', toolResult(`${skill} body`), ts);
  insertMessage(sessionId, 2, 'user', finalUserContent, ts);
}

before(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-health-'));
  process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');

  const catalogRoot = path.join(tempDir, 'catalog');
  makeCatalogSkill(catalogRoot, 'write-spec', '1.0.0');
  makeCatalogSkill(catalogRoot, 'test-strategy', '1.0.0');
  makeCatalogSkill(catalogRoot, 'never-used', '2.0.0');
  makeCatalogSkill(catalogRoot, 'diagnose', '1.0.0');
  makeCatalogSkill(catalogRoot, 'first-principles', '1.0.0');
  // Installed at 2.0.0, but the only invocation is attributed to 1.0.0 (below).
  makeCatalogSkill(catalogRoot, 'bumped', '2.0.0');
  process.env.AGENTMONITOR_SKILL_CATALOG_DIRS = catalogRoot;

  const { initSchema } = await import('../src/db/schema.js');
  const dbModule = await import('../src/db/connection.js');
  initSchema();
  db = dbModule.getDb();
  closeDb = dbModule.closeDb;
  ({ getAnalyticsSkillsDaily, getAnalyticsSkillsHealth } = await import('../src/db/v2-queries.js'));

  // Version snapshot covering the invocation window.
  insertSnapshot('write-spec', '1.0.0', '2026-06-01T00:00:00Z', '2026-07-31T00:00:00Z');
  // `bumped`: 1.0.0 covered the invocation; 2.0.0 is the now-installed version.
  insertSnapshot('bumped', '1.0.0', '2026-06-01T00:00:00Z', '2026-06-30T00:00:00Z');
  insertSnapshot('bumped', '2.0.0', '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z');
  seedInvocation('s-bumped', 'bumped', userText('ok'), '2026-06-15T10:00:00Z');

  // (i) interrupted turn -> misfire.
  seedInvocation('s-misfire', 'write-spec', userText('[Request interrupted by user]'));
  // (ii) clean turn -> not a misfire.
  seedInvocation('s-clean', 'test-strategy', userText('thanks, do the next thing'));
  // (v) invocation of a skill absent from the catalog and snapshots -> null version, retained.
  seedInvocation('s-ghost', 'ghost-skill', userText('ok continue'));

  // (iii) Codex SKILL.md read -> counted, misfire null.
  insertSession('s-codex', 'codex', 'codex-jsonl');
  const codexMsg = insertMessage('s-codex', 0, 'assistant', '[]', '2026-07-02T10:00:00Z');
  insertToolCall(
    codexMsg,
    's-codex',
    'exec_command',
    JSON.stringify({ cmd: 'cat ~/.codex/skills/deep-research/SKILL.md' }),
  );

  // Newer Codex captures use `exec` rather than `exec_command`. Both the JSONL
  // and event-backed analytics paths must recognize it.
  insertSession('s-codex-exec', 'codex', 'codex-jsonl');
  const codexExecMsg = insertMessage('s-codex-exec', 0, 'assistant', '[]', '2026-07-03T10:00:00Z');
  insertToolCall(
    codexExecMsg,
    's-codex-exec',
    'exec',
    JSON.stringify({ cmd: 'cat ~/.agents/skills/diagnose/SKILL.md' }),
  );
  db.prepare(`
    INSERT INTO events (
      event_id, session_id, agent_type, event_type, tool_name, status, project,
      created_at, client_timestamp, metadata, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'codex-exec-skill-event',
    'codex-exec-event-session',
    'codex',
    'tool_use',
    'exec',
    'success',
    'proj',
    '2026-07-04 10:00:00',
    '2026-07-04T10:00:00Z',
    JSON.stringify({ arguments: { cmd: 'cat ~/.agents/skills/first-principles/SKILL.md' } }),
    'otel',
  );

  const { createApp } = await import('../src/app.js');
  const app = createApp({ serveStatic: false });
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server?.close();
  closeDb?.();
});

function rowsByName(): Map<string, SkillHealthRow> {
  return new Map(getAnalyticsSkillsHealth().map(r => [r.name, r]));
}

test('counts an interrupted invocation as a misfire and attributes the installed version', () => {
  const row = rowsByName().get('write-spec');
  assert.ok(row);
  assert.equal(row.invocations, 1);
  assert.equal(row.version, '1.0.0');
  assert.equal(row.versionApproximate, false);
  assert.equal(row.misfires, 1);
  assert.equal(row.misfireRate, 1);
  assert.equal(row.neverFired, false);
});

test('does not count a clean invocation as a misfire', () => {
  const row = rowsByName().get('test-strategy');
  assert.ok(row);
  assert.equal(row.invocations, 1);
  assert.equal(row.misfires, 0);
  assert.equal(row.misfireRate, 0);
});

test('counts a Codex invocation but marks it misfire-ineligible', () => {
  const row = rowsByName().get('deep-research');
  assert.ok(row);
  assert.equal(row.invocations, 1);
  assert.equal(row.misfireEligible, 0);
  assert.equal(row.misfires, null);
  assert.equal(row.misfireRate, null);
});

test('counts newer Codex exec skill reads from JSONL and live events', () => {
  const health = rowsByName();
  assert.equal(health.get('diagnose')?.invocations, 1);
  assert.equal(health.get('first-principles')?.invocations, 1);

  const daily = getAnalyticsSkillsDaily({ date_from: '2026-07-03', date_to: '2026-07-04' });
  const byDate = new Map(daily.map(day => [day.date, day]));
  assert.deepEqual(byDate.get('2026-07-03')?.skills, [{ skill_name: 'diagnose', count: 1 }]);
  assert.deepEqual(byDate.get('2026-07-04')?.skills, [{ skill_name: 'first-principles', count: 1 }]);
});

test('exposes misfireEligible as the denominator behind misfireRate', () => {
  const byName = rowsByName();
  // Explicit Claude invocation -> eligible denominator of 1.
  assert.equal(byName.get('write-spec')?.misfireEligible, 1);
  assert.equal(byName.get('test-strategy')?.misfireEligible, 1);
});

test('retains an invocation whose skill is absent from the catalog with a null version', () => {
  const row = rowsByName().get('ghost-skill');
  assert.ok(row);
  assert.equal(row.invocations, 1);
  assert.equal(row.version, null);
  assert.equal(row.neverFired, false);
});

test('emits never-fired rows for installed catalog skills with no invocations', () => {
  const row = rowsByName().get('never-used');
  assert.ok(row);
  assert.equal(row.neverFired, true);
  assert.equal(row.invocations, 0);
  assert.equal(row.version, '2.0.0');
  assert.equal(row.misfireRate, null);
});

test('surfaces a freshly-installed version as never-fired even when an older version has invocations', () => {
  const rows = getAnalyticsSkillsHealth().filter(r => r.name === 'bumped');
  const byVersion = new Map(rows.map(r => [r.version, r]));
  // 1.0.0 was invoked; 2.0.0 is installed but never fired — both rows present.
  assert.equal(byVersion.get('1.0.0')?.neverFired, false);
  assert.equal(byVersion.get('1.0.0')?.invocations, 1);
  assert.equal(byVersion.get('2.0.0')?.neverFired, true);
  assert.equal(byVersion.get('2.0.0')?.invocations, 0);
});

test('excludes out-of-range invocations but still lists never-fired catalog skills', () => {
  const rows = new Map(
    getAnalyticsSkillsHealth({ date_from: '2026-08-01' }).map(r => [r.name, r]),
  );
  // All seeded invocations predate the range.
  assert.equal(rows.get('write-spec')?.neverFired, true);
  assert.equal(rows.has('ghost-skill'), false);
  assert.equal(rows.get('never-used')?.neverFired, true);
});

test('GET /api/v2/analytics/skills/health returns the daily-style envelope with health rows', async () => {
  const res = await fetch(`${baseUrl}/api/v2/analytics/skills/health`);
  assert.equal(res.status, 200);

  const body = await res.json() as { data: SkillHealthRow[]; coverage: unknown };
  assert.ok(Array.isArray(body.data));
  assert.ok(body.coverage);

  const byName = new Map(body.data.map(r => [r.name, r]));
  assert.equal(byName.get('write-spec')?.misfireRate, 1);
  assert.equal(byName.get('test-strategy')?.misfireRate, 0);
  assert.equal(byName.get('deep-research')?.misfireRate, null);
  assert.equal(byName.get('never-used')?.neverFired, true);
});

test('GET /api/v2/analytics/skills/health honors the date range for backfill queries', async () => {
  const res = await fetch(`${baseUrl}/api/v2/analytics/skills/health?date_from=2026-07-01&date_to=2026-07-01`);
  assert.equal(res.status, 200);

  const body = await res.json() as { data: SkillHealthRow[] };
  const byName = new Map(body.data.map(r => [r.name, r]));
  // Claude invocations dated 2026-07-01 are present; the codex read (07-02) is not.
  assert.equal(byName.get('write-spec')?.invocations, 1);
  assert.equal(byName.get('deep-research'), undefined);
});
