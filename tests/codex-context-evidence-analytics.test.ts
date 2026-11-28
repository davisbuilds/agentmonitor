import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type * as Connection from '../src/db/connection.js';
import type * as Queries from '../src/db/v2-queries.js';
import { CODEX_CONTEXT_EVIDENCE_VERSION } from '../src/skills/codex-evidence-version.js';
import { fingerprintCodexCommand } from '../src/skills/invocation-detection.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-codex-context-analytics-'));
const scratchDb = path.join(scratch, 'test.db');
process.env.AGENTMONITOR_DB_PATH = scratchDb;
process.env.AGENTMONITOR_SKILL_DIRS = path.join(scratch, 'skills');
let connection: typeof Connection;
let queries: typeof Queries;

before(async () => {
  connection = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  initSchema();
  assert.equal(connection.getDb().name, scratchDb);
  queries = await import('../src/db/v2-queries.js');
});
after(() => {
  connection?.closeDb();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('aggregate exposure and consultation classification exclude stale source-missing context', () => {
  const db = connection.getDb();
  const timestamp = '2026-11-27T00:00:00Z';
  const command = 'cat /skills/visible-skill/SKILL.md';
  const oldCapabilities = {
    orderedConsultations: { observable: true },
    compactionVisibility: { observable: true },
    catalogPresentation: { observable: true },
  };
  const currentCapabilities = {
    ...oldCapabilities,
    codexEvidenceVersion: CODEX_CONTEXT_EVIDENCE_VERSION,
    codexCatalogSources: [{ source: 'host', status: 'unknown', reason: 'catalog_format_unsupported' }],
  };
  const insertSession = db.prepare(`
    INSERT INTO browsing_sessions (id, agent, project, started_at, file_path, skill_context_capabilities_json)
    VALUES (?, 'codex', 'fixture', ?, ?, ?)
  `);
  const insertObservation = db.prepare(`
    INSERT INTO session_context_observations (
      session_id, ordinal, kind, source, observed_at, skill_name, command_fingerprint
    ) VALUES (?, ?, ?, 'codex_response_item', ?, ?, ?)
  `);
  const insertCatalogEntry = db.prepare(`
    INSERT INTO session_catalog_observation_entries (observation_id, ordinal, skill_name)
    VALUES (?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (event_id, session_id, agent_type, event_type, tool_name, status,
      project, created_at, client_timestamp, metadata, source)
    VALUES (?, ?, 'codex', 'tool_use', 'exec', 'success', 'fixture', ?, ?, ?, 'otel')
  `);
  for (const [id, capabilities, listedOnly] of [
    ['legacy', oldCapabilities, 'legacy-only'],
    ['current', currentCapabilities, 'current-only'],
  ] as const) {
    insertSession.run(id, timestamp, path.join(scratch, id + '.jsonl'), JSON.stringify(capabilities));
    const catalog = insertObservation.run(id, 0, 'catalog_presentation', timestamp, null, null);
    insertCatalogEntry.run(catalog.lastInsertRowid, 0, 'visible-skill');
    insertCatalogEntry.run(catalog.lastInsertRowid, 1, listedOnly);
    insertObservation.run(id, 1000, 'consultation', timestamp, 'visible-skill', fingerprintCodexCommand(command));
    insertEvent.run('event-' + id, id, timestamp, timestamp, JSON.stringify({ arguments: { cmd: command } }));
  }

  const result = queries.getAnalyticsSkillConsultations({ agent: 'codex', project: 'fixture' });
  const skills = result.byHarness[0]?.skills;
  assert.deepEqual(skills?.map(skill => [skill.name, skill.exposure.jointlyEligiblePresentedSessions]), [
    ['visible-skill', 1],
    ['current-only', 1],
  ]);
  const invocation = skills?.[0];
  assert.equal(invocation?.invocations, 2);
  assert.equal(invocation?.sessionsInWindow, 2);
  assert.equal(invocation?.eligibleSessionsInWindow, 1);
  assert.deepEqual(invocation?.ineligibleSessionsByReason, [
    { reason: 'codex_context_evidence_unverified', sessions: 1 },
  ]);
  assert.equal(invocation?.classes.first_read, 1);
  assert.equal(invocation?.classes.unclassifiable, 1);
  assert.equal(invocation?.exposure.presentedWithFirstRead, 1);
});
