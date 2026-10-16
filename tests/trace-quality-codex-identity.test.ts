import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmonitor-tq-codex-identity-'));
process.env.AGENTMONITOR_DB_PATH = path.join(tempDir, 'test.db');
const { getDb, closeDb } = await import('../src/db/connection.js');
const { initSchema } = await import('../src/db/schema.js');
const { listSessionTraces } = await import('../src/trace-quality/on-demand.js');

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const uuid = '019c26b7-327b-75f3-b000-000000000001';
const rollout = `rollout-2026-02-03T22-34-26-${uuid}`;
const loneUuid = '019c26b7-327b-75f3-b000-000000000002';
const loneRollout = `rollout-2026-02-04T08-00-00-${loneUuid}`;
const claudeUuid = '019c26b7-327b-75f3-b000-000000000003';
const claudeRolloutShaped = `rollout-2026-02-04T01-00-00-${claudeUuid}`;
const mixedUuid = '019c26b7-327b-75f3-b000-000000000004';
const claudeBesideCodex = `rollout-2026-02-04T05-00-00-${mixedUuid}`;
const foreignUuid = '019c26b7-327b-75f3-b000-000000000005';
const codexBesideClaude = `rollout-2026-02-04T06-00-00-${foreignUuid}`;
const resumedUuid = '019c26b7-327b-75f3-b000-000000000006';
const resumedFirst = `rollout-2026-02-05T09-00-00-${resumedUuid}`;
const resumedSecond = `rollout-2026-02-06T09-00-00-${resumedUuid}`;

initSchema();
const db = getDb();
assert.equal(db.name, process.env.AGENTMONITOR_DB_PATH);
const insert = db.prepare(`INSERT INTO session_trace_summary
  (session_id, trace_id, agent_type, started_at, observation_count, cost_usd, coverage_json, projection_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'test')`);
// One Codex session as the watcher (rollout basename, transcript only) and the
// importer/OTEL (native UUID, events with usage) each summarize it.
insert.run(rollout, 'sts:rollout', 'codex', '2026-02-04T03:34:26Z', 322, 0, '{"has_token_usage":false}');
insert.run(uuid, 'sts:uuid', 'codex', '2026-02-04T03:34:26Z', 52, 0.89, '{"has_token_usage":true}');
// A rollout whose UUID has no summary yet (a live session before its events).
insert.run(loneRollout, 'sts:lone', 'codex', '2026-02-04T08:00:00Z', 10, 0, '{}');
// Not Codex: the same id grammar is no evidence of an alias.
insert.run(claudeRolloutShaped, 'sts:claude-a', 'claude', '2026-02-04T01:00:00Z', 5, 0.1, '{}');
insert.run(claudeUuid, 'sts:claude-b', 'claude', '2026-02-04T02:00:00Z', 7, 0.2, '{}');
// Only a Codex row is shadowed, even when a Codex summary holds its UUID.
insert.run(claudeBesideCodex, 'sts:claude-c', 'claude', '2026-02-04T05:00:00Z', 3, 0.05, '{}');
insert.run(mixedUuid, 'sts:codex-mixed', 'codex', '2026-02-04T05:00:00Z', 4, 0.07, '{}');
// ...and only by a Codex summary: another agent's row under that UUID is not its twin.
insert.run(codexBesideClaude, 'sts:codex-foreign', 'codex', '2026-02-04T06:00:00Z', 6, 0, '{}');
insert.run(foreignUuid, 'sts:claude-foreign', 'claude', '2026-02-04T06:00:00Z', 2, 0.01, '{}');
// A resumed session the watcher stored as two rollout files, with no UUID
// summary yet: one session, listed as the rollout with more observations.
insert.run(resumedFirst, 'sts:resumed-1', 'codex', '2026-02-05T09:00:00Z', 12, 0, '{}');
insert.run(resumedSecond, 'sts:resumed-2', 'codex', '2026-02-06T09:00:00Z', 30, 0, '{}');

test('a Codex session summarized under its rollout and its UUID lists once, as the UUID', () => {
  const result = listSessionTraces({ limit: 50 });
  const ids = result.data.map(trace => trace.session_id).sort();
  assert.deepEqual(ids, [loneRollout, uuid, claudeRolloutShaped, claudeUuid, claudeBesideCodex, mixedUuid,
    codexBesideClaude, foreignUuid, resumedSecond].sort());
  assert.equal(result.total, 9);
  assert.equal(result.coverage.matching_traces, 9);
  const codex = result.data.find(trace => trace.session_id === uuid);
  assert.equal(codex?.aggregate.total_cost_usd, 0.89, 'the listed summary carries the event-backed cost');
});

test('the agent filter and its count agree with the list', () => {
  const result = listSessionTraces({ agent: 'codex', limit: 50 });
  assert.deepEqual(result.data.map(trace => trace.session_id).sort(), [loneRollout, uuid, mixedUuid, codexBesideClaude, resumedSecond].sort());
  assert.equal(result.total, 5);
});

test('scoping to a session by its rollout id finds the summary listed for it', () => {
  assert.deepEqual(listSessionTraces({ session_id: rollout }).data.map(trace => trace.session_id), [uuid]);
  assert.deepEqual(listSessionTraces({ session_id: uuid }).data.map(trace => trace.session_id), [uuid]);
  assert.deepEqual(listSessionTraces({ session_id: uuid.toUpperCase() }).data.map(trace => trace.session_id), [uuid],
    'the identity grammar reads a UUID in either case');
  assert.deepEqual(listSessionTraces({ session_id: loneRollout }).data.map(trace => trace.session_id), [loneRollout]);
  assert.deepEqual(listSessionTraces({ session_id: resumedFirst }).data.map(trace => trace.session_id), [resumedSecond]);
});
