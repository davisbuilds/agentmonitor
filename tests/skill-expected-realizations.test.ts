import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Database } from 'better-sqlite3';
import type {
  SkillExpectedPolicyArtifact,
  SkillExpectedRealizationInput,
} from '../src/api/v2/types.js';
import type {
  associateExpectedRealization as associateExpectedRealizationType,
  createExpectedRealization as createExpectedRealizationType,
  getExpectedRealization as getExpectedRealizationType,
  getSessionExpectedRealization as getSessionExpectedRealizationType,
} from '../src/skills/expected-realizations.js';
import type { closeDb as closeDbType } from '../src/db/connection.js';
import type { insertParsedSession as insertParsedSessionType } from '../src/parser/claude-code.js';
import type { parseCodexSessionMessages as parseCodexSessionMessagesType } from '../src/parser/codex-sessions.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-expected-realizations-'));
process.env['AGENTMONITOR_DB_PATH'] = path.join(tempDir, 'test.db');
process.env['AGENTMONITOR_SKILL_DIRS'] = path.join(tempDir, 'skills');

let db: Database;
let closeDb: typeof closeDbType;
let createExpectedRealization: typeof createExpectedRealizationType;
let associateExpectedRealization: typeof associateExpectedRealizationType;
let getExpectedRealization: typeof getExpectedRealizationType;
let getSessionExpectedRealization: typeof getSessionExpectedRealizationType;
let insertParsedSession: typeof insertParsedSessionType;
let parseCodexSessionMessages: typeof parseCodexSessionMessagesType;

before(async () => {
  const connection = await import('../src/db/connection.js');
  const schema = await import('../src/db/schema.js');
  const service = await import('../src/skills/expected-realizations.js');
  ({ insertParsedSession } = await import('../src/parser/claude-code.js'));
  ({ parseCodexSessionMessages } = await import('../src/parser/codex-sessions.js'));
  closeDb = connection.closeDb;
  db = connection.getDb();
  createExpectedRealization = service.createExpectedRealization;
  associateExpectedRealization = service.associateExpectedRealization;
  getExpectedRealization = service.getExpectedRealization;
  getSessionExpectedRealization = service.getSessionExpectedRealization;
  schema.initSchema();
  db.exec(`
    INSERT INTO browsing_sessions (id, project, agent) VALUES
      ('claude-session', 'project', 'claude'),
      ('codex-session', 'project', 'codex')
  `);
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function policyArtifacts(): SkillExpectedPolicyArtifact[] {
  return [
    {
      kind: 'version_scoped_probe',
      artifactId: 'policy-probe',
      artifactRevision: 'probe-r1',
      contentHash: 'sha256:' + 'b'.repeat(64),
      probeIdentity: 'dojo/catalog-limit/v1',
      harness: 'claude',
      harnessVersion: '1.0.80',
      model: 'claude-sonnet',
      modelVersion: '5',
      contextWindowIdentity: 'claude-1m',
      runtimeRepresentation: 'skills_instructions_xml',
      limitValue: 120_000,
      limitUnit: 'utf8_bytes',
      measurementMethod: 'retained_catalog_block_utf8_bytes/v1',
      observedAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z',
      producer: 'dojo',
      producerVersion: '0.1.0',
    },
    {
      kind: 'vendor_policy_snapshot',
      artifactId: 'policy-docs',
      artifactRevision: 'docs-r4',
      contentHash: 'a'.repeat(64),
      sourceUri: 'https://example.com/claude-skill-policy',
      harness: 'claude',
      harnessVersion: '1.0.80',
      model: null,
      modelVersion: null,
      contextWindowIdentity: 'claude-1m',
      runtimeRepresentation: 'skills_instructions_xml',
      limitValue: 125_000,
      limitUnit: 'utf8_bytes',
      measurementMethod: 'retained_catalog_block_utf8_bytes/v1',
      observedAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z',
      producer: 'dojo',
      producerVersion: '0.1.0',
    },
  ];
}

function realization(
  id: string,
  harness: 'claude' | 'codex' = 'claude',
): SkillExpectedRealizationInput {
  return {
    id,
    harness,
    profileIdentity: 'profile:core+research',
    profileComposition: ['research', 'core'],
    canonicalRevision: 'dojo@abc123',
    validFrom: '2026-07-01T00:00:00Z',
    validTo: '2026-08-01T00:00:00Z',
    skills: [
      {
        name: 'write-plan',
        descriptionFingerprint: 'sha256:' + '2'.repeat(64),
        version: '1.0.0',
        contentIdentity: 'sha256:' + '4'.repeat(64),
      },
      {
        name: 'brainstorming',
        descriptionFingerprint: '1'.repeat(64),
        version: '2.0.0',
        contentIdentity: 'sha256:' + '3'.repeat(64),
      },
    ],
    policyArtifacts: harness === 'claude' ? policyArtifacts() : [],
    provenance: {
      producer: 'dojo',
      producerVersion: '0.1.0',
      artifactId: `artifact:${id}`,
      artifactRevision: 'r1',
      sourceUri: 'file:///tmp/dojo-realization.json',
    },
  };
}

test('immutable realizations canonicalize array order and replay idempotently', () => {
  const created = createExpectedRealization(db, realization('realization-canonical'));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.status, 'created');
  assert.match(created.realization.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(created.realization.profileComposition, ['core', 'research']);
  assert.deepEqual(
    created.realization.skills.map(skill => skill.name),
    ['brainstorming', 'write-plan'],
  );
  assert.equal(
    created.realization.skills[1]?.descriptionFingerprint,
    '2'.repeat(64),
  );
  assert.deepEqual(
    created.realization.policyArtifacts.map(policy => policy.artifactId),
    ['policy-docs', 'policy-probe'],
  );
  assert.deepEqual(
    getExpectedRealization(db, 'realization-canonical'),
    created.realization,
  );

  const reordered = realization('realization-canonical');
  reordered.profileComposition.reverse();
  reordered.skills.reverse();
  reordered.policyArtifacts?.reverse();
  const replayed = createExpectedRealization(db, reordered);
  assert.equal(replayed.ok, true);
  if (!replayed.ok) return;
  assert.equal(replayed.status, 'replayed');
  assert.equal(replayed.realization.contentHash, created.realization.contentHash);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count
      FROM skill_expected_realizations
      WHERE id = ?
    `).get('realization-canonical') as { count: number }).count,
    1,
  );
});

test('reusing an immutable ID with different content conflicts without changing storage', () => {
  const original = realization('realization-conflict');
  const created = createExpectedRealization(db, original);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const changed = realization('realization-conflict');
  changed.canonicalRevision = 'dojo@different';
  const conflict = createExpectedRealization(db, changed);
  assert.deepEqual(conflict, {
    ok: false,
    status: 'conflict',
    code: 'expected_realization_content_conflict',
    existingContentHash: created.realization.contentHash,
  });
  assert.equal(
    (db.prepare(`
      SELECT canonical_revision
      FROM skill_expected_realizations
      WHERE id = ?
    `).get('realization-conflict') as { canonical_revision: string }).canonical_revision,
    original.canonicalRevision,
  );
});

test('incomplete or caller-labeled policy authority is rejected without writes', () => {
  const incomplete = realization('realization-incomplete-policy') as unknown as {
    policyArtifacts: Array<Record<string, unknown>>;
  };
  delete incomplete.policyArtifacts[0]!['expiresAt'];
  const incompleteResult = createExpectedRealization(db, incomplete);
  assert.equal(incompleteResult.ok, false);
  if (incompleteResult.ok) return;
  assert.equal(incompleteResult.status, 'invalid');

  const callerLabeled = realization('realization-runtime-label') as unknown as {
    policyArtifacts: Array<Record<string, unknown>>;
  };
  callerLabeled.policyArtifacts[0]!['kind'] = 'harness_runtime';
  const callerLabeledResult = createExpectedRealization(db, callerLabeled);
  assert.equal(callerLabeledResult.ok, false);
  if (callerLabeledResult.ok) return;
  assert.equal(callerLabeledResult.status, 'invalid');

  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count
      FROM skill_expected_realizations
      WHERE id IN (?, ?)
    `).get('realization-incomplete-policy', 'realization-runtime-label') as { count: number }).count,
    0,
  );
});

test('model scope accepts an exact model identifier and rejects a version without a model', () => {
  const exactModel = realization('realization-exact-model');
  exactModel.policyArtifacts![0]!.model = 'claude-sonnet-5';
  exactModel.policyArtifacts![0]!.modelVersion = null;
  const exactModelResult = createExpectedRealization(db, exactModel);
  assert.equal(exactModelResult.ok, true);

  const versionOnly = realization('realization-version-without-model');
  versionOnly.policyArtifacts![0]!.model = null;
  versionOnly.policyArtifacts![0]!.modelVersion = '5';
  const versionOnlyResult = createExpectedRealization(db, versionOnly);
  assert.equal(versionOnlyResult.ok, false);
  if (versionOnlyResult.ok) return;
  assert.equal(versionOnlyResult.status, 'invalid');
});

test('calendar-invalid authority timestamps are rejected without writes', () => {
  const invalidValidity = realization('realization-invalid-calendar-validity');
  invalidValidity.validFrom = '2026-02-30T00:00:00Z';
  const invalidValidityResult = createExpectedRealization(db, invalidValidity);
  assert.equal(invalidValidityResult.ok, false);
  if (invalidValidityResult.ok) return;
  assert.equal(invalidValidityResult.status, 'invalid');
  assert.ok(invalidValidityResult.issues.some(issue =>
    issue.path === 'validFrom' && issue.code === 'invalid_timestamp'
  ));

  const invalidPolicyExpiry = realization('realization-invalid-calendar-policy');
  invalidPolicyExpiry.policyArtifacts![0]!.expiresAt = '2026-09-31T00:00:00Z';
  const invalidPolicyResult = createExpectedRealization(db, invalidPolicyExpiry);
  assert.equal(invalidPolicyResult.ok, false);
  if (invalidPolicyResult.ok) return;
  assert.equal(invalidPolicyResult.status, 'invalid');
  assert.ok(invalidPolicyResult.issues.some(issue =>
    issue.path === 'policyArtifacts[0].expiresAt' &&
    issue.code === 'invalid_timestamp'
  ));

  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count
      FROM skill_expected_realizations
      WHERE id IN (?, ?)
    `).get(
      'realization-invalid-calendar-validity',
      'realization-invalid-calendar-policy',
    ) as { count: number }).count,
    0,
  );
});

test('associations require existing same-harness resources and reject rebinding', () => {
  const first = createExpectedRealization(db, realization('realization-association'));
  assert.equal(first.ok, true);
  const second = createExpectedRealization(db, realization('realization-association-2'));
  assert.equal(second.ok, true);

  assert.deepEqual(
    associateExpectedRealization(db, 'missing-session', 'realization-association'),
    { ok: false, status: 'not_found', code: 'session_not_found' },
  );
  assert.deepEqual(
    associateExpectedRealization(db, 'claude-session', 'missing-realization'),
    { ok: false, status: 'not_found', code: 'expected_realization_not_found' },
  );
  assert.deepEqual(
    associateExpectedRealization(db, 'codex-session', 'realization-association'),
    {
      ok: false,
      status: 'unprocessable',
      code: 'expected_realization_harness_mismatch',
      sessionHarness: 'codex',
      realizationHarness: 'claude',
    },
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count
      FROM session_expected_skill_realizations
      WHERE session_id IN ('missing-session', 'claude-session', 'codex-session')
    `).get() as { count: number }).count,
    0,
  );
  assert.deepEqual(
    associateExpectedRealization(db, 'claude-session', 'realization-association'),
    {
      ok: true,
      status: 'associated',
      sessionId: 'claude-session',
      realizationId: 'realization-association',
    },
  );
  assert.deepEqual(
    associateExpectedRealization(db, 'claude-session', 'realization-association'),
    {
      ok: true,
      status: 'replayed',
      sessionId: 'claude-session',
      realizationId: 'realization-association',
    },
  );
  assert.deepEqual(
    associateExpectedRealization(db, 'claude-session', 'realization-association-2'),
    {
      ok: false,
      status: 'conflict',
      code: 'session_expected_realization_conflict',
      existingRealizationId: 'realization-association',
    },
  );
  assert.equal(
    (db.prepare(`
      SELECT realization_id
      FROM session_expected_skill_realizations
      WHERE session_id = 'claude-session'
    `).get() as { realization_id: string }).realization_id,
    'realization-association',
  );
});

test('session association survives transcript reparse', () => {
  const input = realization('realization-reparse', 'codex');
  const created = createExpectedRealization(db, input);
  assert.equal(created.ok, true);

  const source = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-01T00:00:00Z',
      payload: { cwd: '/work/project' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-01T00:00:01Z',
      payload: { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    }),
  ].join('\n');
  const parsed = parseCodexSessionMessages(source, 'codex-reparse-session');
  insertParsedSession(db, parsed, '/tmp/codex-reparse.jsonl', 1, 'first');
  const associated = associateExpectedRealization(
    db,
    'codex-reparse-session',
    'realization-reparse',
  );
  assert.equal(associated.ok, true);

  insertParsedSession(db, parsed, '/tmp/codex-reparse.jsonl', 2, 'second');
  assert.equal(
    getSessionExpectedRealization(db, 'codex-reparse-session')?.id,
    'realization-reparse',
  );
});
