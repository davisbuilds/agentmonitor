import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-change-markers-'));
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

let eventId = 0;
const event = db.prepare(`INSERT INTO events (event_id, session_id, agent_type, event_type, model, source, created_at, client_timestamp)
  VALUES (?, 's', ?, 'llm_response', ?, ?, '2026-04-01T00:00:00Z', ?)`);
const uses = (agent: string, model: string, days: string[], source = 'import') => {
  for (const day of days) event.run(`e${eventId++}`, agent, model, source, `${day}T12:00:00Z`);
};
uses('claude_code', 'claude-opus-4', ['2026-02-01', '2026-02-02', '2026-02-03', '2026-03-05']);
uses('claude_code', 'claude-opus-5', ['2026-03-04', '2026-03-06', '2026-03-09']);
uses('claude_code', 'claude-trial', ['2026-03-05', '2026-03-07']);
uses('codex', 'gpt-6', ['2026-03-08', '2026-03-10', '2026-03-12']);
uses('codex', 'codex-auto-review', ['2026-03-02', '2026-03-03', '2026-03-04']);
uses('codex', 'gpt-bench', ['2026-03-02', '2026-03-03', '2026-03-04'], 'benchmark');
// Claude Code's own error and rate-limit notices name no real model.
uses('claude_code', '<synthetic>', ['2026-03-02', '2026-03-03', '2026-03-04']);

const root = path.join(tempDir, 'alpha');
const commit = db.prepare(`INSERT INTO git_commits (repo_root, sha, authored_at, committed_at, subject, files_json, is_merge)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const commits = (repo: string, sha: string, at: string, subject: string, files: string[], isMerge = 0) =>
  commit.run(repo, sha, at, at, subject, JSON.stringify(files), isMerge);
commits(root, 'a1', '2026-03-03T10:00:00Z', 'docs: agent rules', ['AGENTS.md', 'README.md']);
commits(root, 'a2', '2026-03-03T15:00:00Z', 'docs: agent rules (#4)', ['AGENTS.md', 'frontend/CLAUDE.md']);
commits(root, 'a3', '2026-03-05T10:00:00Z', 'docs: a draft about agents', ['notes/revised-AGENTS.md']);
commits(root, 'a4', '2026-03-06T10:00:00Z', 'Merge pull request #5 from owner/x', ['AGENTS.md'], 1);
commits(path.join(tempDir, 'beta'), 'b1', '2026-03-07T10:00:00Z', 'docs: beta rules', ['CLAUDE.md']);

const range = { date_from: '2026-03-01', date_to: '2026-03-31' };
const summary = (markers: ReturnType<typeof queries.getAnalyticsChangeMarkers>['markers']) => markers.map(marker =>
  marker.kind === 'model' ? `${marker.date} model ${marker.agent} ${marker.model}` : `${marker.date} instructions ${marker.project} ${marker.files.join(',')} ${marker.commits.map(c => c.sha).join(',')}`);

test('markers are models an agent took up and days a project changed its instructions', () => {
  assert.deepEqual(summary(queries.getAnalyticsChangeMarkers(range).markers), [
    '2026-03-03 instructions alpha AGENTS.md,frontend/CLAUDE.md a1,a2',
    '2026-03-04 model claude claude-opus-5',
    '2026-03-07 instructions beta CLAUDE.md b1',
    '2026-03-08 model codex gpt-6',
  ]);
});

test('the project filter narrows instructions only, and the agent filter models only', () => {
  assert.deepEqual(summary(queries.getAnalyticsChangeMarkers({ ...range, project: 'beta' }).markers), [
    '2026-03-04 model claude claude-opus-5',
    '2026-03-07 instructions beta CLAUDE.md b1',
    '2026-03-08 model codex gpt-6',
  ]);
  assert.deepEqual(summary(queries.getAnalyticsChangeMarkers({ ...range, agent: 'codex' }).markers), [
    '2026-03-03 instructions alpha AGENTS.md,frontend/CLAUDE.md a1,a2',
    '2026-03-07 instructions beta CLAUDE.md b1',
    '2026-03-08 model codex gpt-6',
  ]);
});

test('a model first used before the range is no change within it', () => {
  assert.deepEqual(summary(queries.getAnalyticsChangeMarkers({ date_from: '2026-03-05', date_to: '2026-03-31' }).markers), [
    '2026-03-07 instructions beta CLAUDE.md b1',
    '2026-03-08 model codex gpt-6',
  ]);
});

const { setReportingTimeZoneForTests } = await import('../src/util/local-day.js');
const at = (agent: string, model: string, instants: string[]) => {
  for (const instant of instants) event.run(`e${eventId++}`, agent, model, 'import', instant);
};
// Three UTC days but two in Los Angeles: tried, not taken up there.
at('claude_code', 'claude-late-night', ['2026-04-01T23:30:00Z', '2026-04-02T00:30:00Z', '2026-04-03T00:30:00Z']);
// Two UTC days but three in Los Angeles, the first of them Apr 19.
at('claude_code', 'claude-west', ['2026-04-20T05:00:00Z', '2026-04-20T15:00:00Z', '2026-04-21T08:00:00Z']);

test('a model is taken up on three days of the reporting zone, not of UTC', () => {
  setReportingTimeZoneForTests('America/Los_Angeles');
  try {
    assert.deepEqual(summary(queries.getAnalyticsChangeMarkers({ date_from: '2026-04-01', date_to: '2026-04-30' }).markers), [
      '2026-04-19 model claude claude-west',
    ]);
  } finally {
    setReportingTimeZoneForTests(null);
  }
});

test("a model's first use is its earliest instant, whichever column holds the time", () => {
  const stored = db.prepare(`INSERT INTO events (event_id, session_id, agent_type, event_type, model, source, created_at, client_timestamp)
    VALUES (?, 's', 'claude_code', 'llm_response', 'claude-mixed', 'import', ?, ?)`);
  // SQLite's own `YYYY-MM-DD HH:MM:SS` sorts before any ISO time on its date.
  stored.run(`e${eventId++}`, '2026-05-04 10:00:00', null);
  stored.run(`e${eventId++}`, '2026-05-04 09:00:00', '2026-05-04T07:00:00Z');
  stored.run(`e${eventId++}`, '2026-05-05 10:00:00', null);
  stored.run(`e${eventId++}`, '2026-05-06 10:00:00', null);
  const [marker] = queries.getAnalyticsChangeMarkers({ date_from: '2026-05-01', date_to: '2026-05-31' }).markers;
  assert.equal(marker?.kind === 'model' && marker.model, 'claude-mixed');
  assert.equal(marker.at, '2026-05-04T07:00:00.000Z');
});
