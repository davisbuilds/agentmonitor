import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import type { SkillExpectedRealizationInput } from '../src/api/v2/types.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-skill-context-api-'));
process.env['AGENTMONITOR_DB_PATH'] = path.join(tempDir, 'test.db');
process.env['AGENTMONITOR_SKILL_DIRS'] = path.join(tempDir, 'skills');

let server: Server;
let baseUrl = '';
let db: Database.Database;
let closeDb: () => void;

function realization(
  id: string,
  harness: 'claude' | 'codex' = 'claude',
): SkillExpectedRealizationInput {
  return {
    id,
    harness,
    profileIdentity: 'profile:core',
    profileComposition: ['core'],
    canonicalRevision: 'dojo@abc123',
    validFrom: '2026-07-01T00:00:00Z',
    validTo: '2026-08-01T00:00:00Z',
    skills: [{
      name: 'write-plan',
      descriptionFingerprint: '1'.repeat(64),
      version: '1.0.0',
      contentIdentity: '2'.repeat(64),
    }],
    provenance: {
      producer: 'dojo',
      producerVersion: '0.1.0',
      artifactId: `artifact:${id}`,
      artifactRevision: 'r1',
      sourceUri: 'file:///tmp/dojo-realization.json',
    },
  };
}

async function putJson(route: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  const { initSchema } = await import('../src/db/schema.js');
  const connection = await import('../src/db/connection.js');
  initSchema();
  db = connection.getDb();
  closeDb = connection.closeDb;
  db.exec(`
    INSERT INTO browsing_sessions (
      id, project, agent, started_at, ended_at, live_status,
      skill_context_capabilities_json
    ) VALUES
      (
        'claude-context-session',
        'agentmonitor',
        'claude',
        '2026-07-10T10:00:00Z',
        '2026-07-10T10:05:00Z',
        'live',
        '{"orderedConsultations":{"observable":true},"compactionVisibility":{"observable":true},"catalogPresentation":{"observable":false,"reason":"presentation_signal_absent"},"instructionLoads":{"observable":false,"reason":"instruction_load_signal_absent"}}'
      ),
      (
        'codex-context-session',
        'agentmonitor',
        'codex',
        '2026-07-10T11:00:00Z',
        '2026-07-10T11:05:00Z',
        'ended',
        '{}'
      )
  `);

  const { createApp } = await import('../src/app.js');
  server = createApp({ serveStatic: false }).listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  server.close();
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('GET session skill context distinguishes unknown and known unavailable states', async () => {
  const missing = await fetch(`${baseUrl}/api/v2/sessions/missing/skill-context`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    error: 'Session not found',
    code: 'session_not_found',
  });

  const response = await fetch(
    `${baseUrl}/api/v2/sessions/claude-context-session/skill-context`,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    sessionId: string;
    consultationClassification: { observable: boolean };
    catalog: { observable: boolean; reason: string };
    expectedRealization: { status: string; reason: string };
    instructions: { observable: boolean; reason: string };
  };
  assert.equal(body.sessionId, 'claude-context-session');
  assert.deepEqual(body.consultationClassification, { observable: true });
  assert.equal(body.catalog.observable, false);
  assert.equal(body.catalog.reason, 'presentation_signal_absent');
  assert.deepEqual(body.expectedRealization, {
    status: 'unavailable',
    reason: 'no_expected_realization',
  });
  assert.equal(body.instructions.observable, false);
  assert.equal(body.instructions.reason, 'instruction_load_signal_absent');
});

test('GET session skill context treats a live projection as active', async () => {
  const response = await fetch(
    `${baseUrl}/api/v2/sessions/claude-context-session/skill-context`,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { active: boolean }).active, true);
});

test('PUT expected realization validates the resource ID and body shape', async () => {
  const primitive = await putJson(
    '/api/v2/skills/expected-realizations/realization-invalid-body',
    [],
  );
  assert.equal(primitive.status, 400);
  assert.equal((await primitive.json() as { code: string }).code, 'invalid_json_object');

  const mismatch = realization('body-id');
  const mismatched = await putJson(
    '/api/v2/skills/expected-realizations/path-id',
    mismatch,
  );
  assert.equal(mismatched.status, 400);
  assert.equal(
    (await mismatched.json() as { code: string }).code,
    'resource_id_mismatch',
  );

  const missingField = realization('realization-missing-field') as unknown as Record<string, unknown>;
  delete missingField['provenance'];
  const invalid = await putJson(
    '/api/v2/skills/expected-realizations/realization-missing-field',
    missingField,
  );
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json() as {
    code: string;
    issues: Array<{ path: string }>;
  };
  assert.equal(invalidBody.code, 'invalid_expected_realization');
  assert.ok(invalidBody.issues.some(issue => issue.path === 'provenance'));
});

test('PUT expected realization creates, replays, conflicts, and rejects policy mismatch', async () => {
  const input = realization('realization-lifecycle');
  const created = await putJson(
    '/api/v2/skills/expected-realizations/realization-lifecycle',
    input,
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json() as {
    ok: boolean;
    status: string;
    realization: { id: string; contentHash: string };
  };
  assert.equal(createdBody.ok, true);
  assert.equal(createdBody.status, 'created');
  assert.equal(createdBody.realization.id, 'realization-lifecycle');
  assert.match(createdBody.realization.contentHash, /^[a-f0-9]{64}$/);

  const replayed = await putJson(
    '/api/v2/skills/expected-realizations/realization-lifecycle',
    input,
  );
  assert.equal(replayed.status, 200);
  assert.equal((await replayed.json() as { status: string }).status, 'replayed');

  const changed = realization('realization-lifecycle');
  changed.canonicalRevision = 'dojo@different';
  const conflict = await putJson(
    '/api/v2/skills/expected-realizations/realization-lifecycle',
    changed,
  );
  assert.equal(conflict.status, 409);
  assert.equal(
    (await conflict.json() as { code: string }).code,
    'expected_realization_content_conflict',
  );

  const policyMismatch = realization('realization-policy-mismatch') as unknown as {
    policyArtifacts: Array<Record<string, unknown>>;
  } & SkillExpectedRealizationInput;
  policyMismatch.policyArtifacts = [{
    kind: 'version_scoped_probe',
    artifactId: 'policy-mismatch',
    artifactRevision: 'r1',
    contentHash: '3'.repeat(64),
    probeIdentity: 'dojo/catalog-limit/v1',
    harness: 'codex',
    harnessVersion: '1.0.0',
    model: null,
    modelVersion: null,
    contextWindowIdentity: 'default',
    runtimeRepresentation: 'skills_instructions_xml',
    limitValue: 1_024,
    limitUnit: 'utf8_bytes',
    measurementMethod: 'retained_catalog_block_utf8_bytes/v1',
    observedAt: '2026-07-01T00:00:00Z',
    expiresAt: '2026-08-01T00:00:00Z',
    producer: 'dojo',
    producerVersion: '0.1.0',
  }];
  const unprocessable = await putJson(
    '/api/v2/skills/expected-realizations/realization-policy-mismatch',
    policyMismatch,
  );
  assert.equal(unprocessable.status, 422);
  assert.equal(
    (await unprocessable.json() as { code: string }).code,
    'invalid_expected_realization',
  );
});

test('PUT session association covers create, replay, dependencies, harness, and rebind', async () => {
  const missingBody = await putJson(
    '/api/v2/sessions/claude-context-session/expected-skill-realization',
    {},
  );
  assert.equal(missingBody.status, 400);
  assert.equal(
    (await missingBody.json() as { code: string }).code,
    'invalid_association',
  );

  const missingSession = await putJson(
    '/api/v2/sessions/missing-session/expected-skill-realization',
    { realizationId: 'realization-lifecycle' },
  );
  assert.equal(missingSession.status, 404);
  assert.equal((await missingSession.json() as { code: string }).code, 'session_not_found');

  const missingRealization = await putJson(
    '/api/v2/sessions/claude-context-session/expected-skill-realization',
    { realizationId: 'missing-realization' },
  );
  assert.equal(missingRealization.status, 404);
  assert.equal(
    (await missingRealization.json() as { code: string }).code,
    'expected_realization_not_found',
  );

  const harnessMismatch = await putJson(
    '/api/v2/sessions/codex-context-session/expected-skill-realization',
    { realizationId: 'realization-lifecycle' },
  );
  assert.equal(harnessMismatch.status, 422);
  assert.equal(
    (await harnessMismatch.json() as { code: string }).code,
    'expected_realization_harness_mismatch',
  );

  const associated = await putJson(
    '/api/v2/sessions/claude-context-session/expected-skill-realization',
    { realizationId: 'realization-lifecycle' },
  );
  assert.equal(associated.status, 201);
  assert.equal((await associated.json() as { status: string }).status, 'associated');

  const replayed = await putJson(
    '/api/v2/sessions/claude-context-session/expected-skill-realization',
    { realizationId: 'realization-lifecycle' },
  );
  assert.equal(replayed.status, 200);
  assert.equal((await replayed.json() as { status: string }).status, 'replayed');

  const second = realization('realization-second');
  assert.equal(
    (await putJson(
      '/api/v2/skills/expected-realizations/realization-second',
      second,
    )).status,
    201,
  );
  const conflict = await putJson(
    '/api/v2/sessions/claude-context-session/expected-skill-realization',
    { realizationId: 'realization-second' },
  );
  assert.equal(conflict.status, 409);
  assert.equal(
    (await conflict.json() as { code: string }).code,
    'session_expected_realization_conflict',
  );
});
