import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Database } from 'better-sqlite3';
import type {
  SkillExpectedRealizationInput,
  SkillExpectedVendorPolicyArtifact,
} from '../src/api/v2/types.js';
import type {
  associateExpectedRealization as associateExpectedRealizationType,
  createExpectedRealization as createExpectedRealizationType,
} from '../src/skills/expected-realizations.js';
import type {
  getSessionSkillContext as getSessionSkillContextType,
} from '../src/skills/session-skill-context.js';
import type { closeDb as closeDbType } from '../src/db/connection.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amon-session-skill-context-'));
process.env['AGENTMONITOR_DB_PATH'] = path.join(tempDir, 'test.db');
process.env['AGENTMONITOR_SKILL_DIRS'] = path.join(tempDir, 'skills');

let db: Database;
let closeDb: typeof closeDbType;
let createExpectedRealization: typeof createExpectedRealizationType;
let associateExpectedRealization: typeof associateExpectedRealizationType;
let getSessionSkillContext: typeof getSessionSkillContextType;

before(async () => {
  const connection = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  const expected = await import('../src/skills/expected-realizations.js');
  const projector = await import('../src/skills/session-skill-context.js');
  closeDb = connection.closeDb;
  db = connection.getDb();
  initSchema();
  createExpectedRealization = expected.createExpectedRealization;
  associateExpectedRealization = expected.associateExpectedRealization;
  getSessionSkillContext = projector.getSessionSkillContext;
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function capabilities(options: {
  catalog?: { observable: boolean; reason?: string };
  instructions?: { observable: boolean; reason?: string };
  consultations?: { observable: boolean; reason?: string };
  compactions?: { observable: boolean; reason?: string };
} = {}): string {
  return JSON.stringify({
    orderedConsultations: options.consultations ?? { observable: true },
    compactionVisibility: options.compactions ?? { observable: true },
    catalogPresentation: options.catalog ?? {
      observable: false,
      reason: 'presentation_signal_absent',
    },
    instructionLoads: options.instructions ?? {
      observable: false,
      reason: 'instruction_load_signal_absent',
    },
    diagnostics: [],
  });
}

function insertSession(
  id: string,
  harness: 'claude' | 'codex',
  capabilityJson: string,
  options: { endedAt?: string | null; liveStatus?: string | null } = {},
): void {
  db.prepare(`
    INSERT INTO browsing_sessions (
      id, project, agent, started_at, ended_at, live_status,
      skill_context_capabilities_json
    ) VALUES (?, 'project', ?, '2026-07-01T00:00:00.000Z', ?, ?, ?)
  `).run(
    id,
    harness,
    options.endedAt ?? null,
    options.liveStatus ?? null,
    capabilityJson,
  );
}

function insertObservation(input: {
  sessionId: string;
  ordinal: number;
  kind: 'consultation' | 'compaction' | 'catalog_presentation' | 'instruction_load';
  observedAt?: string | null;
  skillName?: string | null;
  source?: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  entries?: Array<{
    name: string;
    description: string | null;
    descriptionFingerprint: string | null;
    sourceLocation?: string | null;
    scope?: string | null;
  }>;
}): number {
  const result = db.prepare(`
    INSERT INTO session_context_observations (
      session_id, ordinal, kind, source, observed_at, skill_name,
      project_identity, reason, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'cwd:project', ?, ?)
  `).run(
    input.sessionId,
    input.ordinal,
    input.kind,
    input.source ?? 'fixture',
    input.observedAt ?? null,
    input.skillName ?? null,
    input.reason ?? null,
    JSON.stringify(input.metadata ?? {}),
  );
  const observationId = Number(result.lastInsertRowid);
  for (const [ordinal, entry] of (input.entries ?? []).entries()) {
    db.prepare(`
      INSERT INTO session_catalog_observation_entries (
        observation_id, ordinal, skill_name, description,
        description_fingerprint, source_location, scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      observationId,
      ordinal,
      entry.name,
      entry.description,
      entry.descriptionFingerprint,
      entry.sourceLocation ?? null,
      entry.scope ?? null,
    );
  }
  return observationId;
}

function policy(
  overrides: Partial<SkillExpectedVendorPolicyArtifact> = {},
): SkillExpectedVendorPolicyArtifact {
  return {
    kind: 'vendor_policy_snapshot',
    artifactId: 'policy',
    artifactRevision: 'r1',
    contentHash: 'a'.repeat(64),
    sourceUri: 'https://example.com/codex-policy',
    harness: 'codex',
    harnessVersion: '0.145.0',
    model: null,
    modelVersion: null,
    contextWindowIdentity: 'tokens:258400',
    runtimeRepresentation: 'skills_instructions_xml',
    limitValue: 256,
    limitUnit: 'utf8_bytes',
    measurementMethod: 'retained_catalog_block_utf8_bytes/v1',
    observedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-02T00:00:00.000Z',
    producer: 'vendor-docs',
    producerVersion: '1',
    ...overrides,
  };
}

function realization(
  id: string,
  policyArtifact: SkillExpectedVendorPolicyArtifact = policy(),
): SkillExpectedRealizationInput {
  return {
    id,
    harness: 'codex',
    profileIdentity: 'profile:core',
    profileComposition: ['core'],
    canonicalRevision: 'dojo@revision',
    validFrom: '2026-07-01T00:00:00.000Z',
    validTo: '2026-07-02T00:00:00.000Z',
    skills: [
      {
        name: 'alpha',
        descriptionFingerprint: sha256('Alpha description'),
      },
      {
        name: 'beta',
        descriptionFingerprint: sha256('Beta description'),
      },
      {
        name: 'delta',
        descriptionFingerprint: sha256('Expected delta'),
      },
    ],
    policyArtifacts: [policyArtifact],
    provenance: {
      producer: 'dojo',
      producerVersion: '1',
      artifactId: `artifact:${id}`,
      artifactRevision: 'r1',
      sourceUri: 'file:///tmp/realization.json',
    },
  };
}

function runtimeMetadata(
  measurement: { value: number; unit: string; method: string } = {
    value: 128,
    unit: 'utf8_bytes',
    method: 'skill_catalog_presentation/v1',
  },
): Record<string, unknown> {
  return {
    measurement,
    truncation: 'unknown',
    runtime: {
      harnessVersion: '0.145.0',
      model: null,
      modelVersion: null,
      contextWindowIdentity: 'tokens:258400',
      representation: 'skills_instructions_xml',
    },
  };
}

test('projects distinct presentations with occurrence-valid comparison and budget', () => {
  const sessionId = 'context-comparison';
  insertSession(sessionId, 'codex', capabilities({
    catalog: { observable: true },
  }), { liveStatus: 'active' });
  insertObservation({
    sessionId,
    ordinal: 1,
    kind: 'consultation',
    observedAt: '2026-07-01T10:00:00.000Z',
    skillName: 'alpha',
  });
  insertObservation({
    sessionId,
    ordinal: 2,
    kind: 'compaction',
    observedAt: '2026-07-01T11:00:00.000Z',
  });
  insertObservation({
    sessionId,
    ordinal: 3,
    kind: 'consultation',
    observedAt: '2026-07-01T11:30:00.000Z',
    skillName: 'alpha',
  });
  insertObservation({
    sessionId,
    ordinal: 4,
    kind: 'catalog_presentation',
    observedAt: '2026-07-01T12:00:00.000Z',
    metadata: runtimeMetadata(),
    entries: [
      {
        name: 'alpha',
        description: 'Alpha description',
        descriptionFingerprint: sha256('Alpha description'),
        sourceLocation: '/skills/alpha/SKILL.md',
      },
      {
        name: 'gamma',
        description: 'Gamma description',
        descriptionFingerprint: sha256('Gamma description'),
      },
      {
        name: 'delta',
        description: 'Observed delta',
        descriptionFingerprint: sha256('Observed delta'),
      },
    ],
  });
  insertObservation({
    sessionId,
    ordinal: 5,
    kind: 'catalog_presentation',
    observedAt: '2026-07-02T00:00:00.000Z',
    metadata: runtimeMetadata({ value: 96, unit: 'utf8_bytes', method: 'skill_catalog_presentation/v1' }),
    entries: [{
      name: 'alpha',
      description: 'Changed alpha',
      descriptionFingerprint: sha256('Changed alpha'),
    }],
  });
  insertObservation({
    sessionId,
    ordinal: 6,
    kind: 'catalog_presentation',
    observedAt: null,
    metadata: runtimeMetadata({ value: 64, unit: 'utf8_bytes', method: 'skill_catalog_presentation/v1' }),
    entries: [],
  });

  const created = createExpectedRealization(db, realization('expected-comparison'));
  assert.equal(created.ok, true);
  assert.equal(
    associateExpectedRealization(db, sessionId, 'expected-comparison').ok,
    true,
  );

  const result = getSessionSkillContext(db, sessionId);
  assert.ok(result);
  assert.equal(result.active, true);
  assert.deepEqual(
    result.observations
      .filter(observation => observation.kind === 'consultation')
      .map(observation => observation.consultationClass),
    ['first_read', 'rehydration_after_compaction'],
  );
  assert.equal(result.catalog.observable, true);
  if (!result.catalog.observable) return;
  assert.equal(result.catalog.occurrences.length, 3);
  assert.notEqual(
    result.catalog.occurrences[0]?.fingerprint,
    result.catalog.occurrences[1]?.fingerprint,
  );
  assert.equal(
    result.catalog.occurrences[0]?.fingerprint,
    sha256(JSON.stringify([
      {
        ordinal: 0,
        name: 'alpha',
        description: 'Alpha description',
        sourceLocation: '/skills/alpha/SKILL.md',
        sourceScope: null,
      },
      {
        ordinal: 1,
        name: 'gamma',
        description: 'Gamma description',
        sourceLocation: null,
        sourceScope: null,
      },
      {
        ordinal: 2,
        name: 'delta',
        description: 'Observed delta',
        sourceLocation: null,
        sourceScope: null,
      },
    ])),
  );
  assert.deepEqual(result.catalog.occurrences[0]?.measurement, {
    value: 128,
    unit: 'utf8_bytes',
    method: 'retained_catalog_block_utf8_bytes/v1',
    exact: true,
  });

  const initialComparison = result.catalog.occurrences[0]?.comparison;
  assert.equal(initialComparison?.status, 'compared');
  if (initialComparison?.status !== 'compared') return;
  assert.deepEqual(initialComparison.matching, ['alpha']);
  assert.deepEqual(initialComparison.omitted, ['beta']);
  assert.deepEqual(initialComparison.unexpected, ['gamma']);
  assert.deepEqual(
    initialComparison.descriptionMismatched.map(item => item.name),
    ['delta'],
  );
  assert.deepEqual(result.catalog.occurrences[0]?.budget, {
    status: 'available',
    used: 128,
    limit: 256,
    ratio: 0.5,
    unit: 'utf8_bytes',
    measurementMethod: 'retained_catalog_block_utf8_bytes/v1',
    policyArtifactId: 'policy',
    policyArtifactRevision: 'r1',
    policyArtifactHash: 'a'.repeat(64),
  });
  assert.deepEqual(result.catalog.occurrences[1]?.comparison, {
    status: 'unavailable',
    reason: 'realization_not_valid_for_occurrence',
  });
  assert.deepEqual(result.catalog.occurrences[2]?.comparison, {
    status: 'unavailable',
    reason: 'occurrence_timestamp_unavailable',
  });
});

test('keeps observed-empty catalog distinct from unavailable presentation', () => {
  insertSession('catalog-empty', 'codex', capabilities({
    catalog: { observable: true },
  }));
  insertObservation({
    sessionId: 'catalog-empty',
    ordinal: 1,
    kind: 'catalog_presentation',
    observedAt: '2026-07-01T12:00:00.000Z',
    metadata: runtimeMetadata({ value: 20, unit: 'utf8_bytes', method: 'skill_catalog_presentation/v1' }),
    entries: [],
  });
  insertSession('catalog-unavailable', 'claude', capabilities({
    catalog: { observable: false, reason: 'harness_signal_unavailable' },
  }));

  const empty = getSessionSkillContext(db, 'catalog-empty');
  assert.equal(empty?.catalog.observable, true);
  if (!empty?.catalog.observable) return;
  assert.equal(empty.catalog.occurrences.length, 1);
  assert.deepEqual(empty.catalog.occurrences[0]?.entries, []);

  assert.deepEqual(getSessionSkillContext(db, 'catalog-unavailable')?.catalog, {
    observable: false,
    reason: 'harness_signal_unavailable',
    occurrences: [],
    comparison: {
      status: 'unavailable',
      reason: 'presentation_unobservable',
    },
    budget: {
      status: 'unknown',
      reason: 'measurement_unavailable',
    },
  });
});

test('distinguishes received, instrumented-undelivered, missing, and explicit-empty instructions', () => {
  insertSession('instructions-received', 'claude', capabilities());
  insertSession('instructions-undelivered', 'claude', capabilities());
  insertSession('instructions-missing', 'claude', capabilities());
  insertSession('instructions-empty-codex', 'codex', capabilities({
    instructions: { observable: true },
  }));

  const insertEvent = db.prepare(`
    INSERT INTO events (
      session_id, agent_type, event_type, created_at, client_timestamp, metadata, source
    ) VALUES (?, 'claude_code', ?, ?, ?, ?, 'hook')
  `);
  insertEvent.run(
    'instructions-received',
    'session_start',
    '2026-07-01 00:00:00',
    '2026-07-01T00:00:00.000Z',
    JSON.stringify({ instruction_load_instrumented: true }),
  );
  insertEvent.run(
    'instructions-received',
    'instruction_load',
    '2026-07-01 00:00:01',
    '2026-07-01T00:00:01.000Z',
    JSON.stringify({
      file_path: '/work/AGENTS.md',
      memory_type: 'Project',
      load_reason: 'session_start',
    }),
  );
  insertEvent.run(
    'instructions-received',
    'instruction_load',
    '2026-07-01 00:00:02',
    '2026-07-01T00:00:02.000Z',
    JSON.stringify({
      file_path: '/work/AGENTS.md',
      memory_type: 'Project',
      load_reason: 'compact',
    }),
  );
  insertEvent.run(
    'instructions-undelivered',
    'session_start',
    '2026-07-01 00:00:00',
    '2026-07-01T00:00:00.000Z',
    JSON.stringify({ instruction_load_instrumented: true }),
  );
  insertEvent.run(
    'instructions-missing',
    'session_start',
    '2026-07-01 00:00:00',
    '2026-07-01T00:00:00.000Z',
    '{}',
  );

  const received = getSessionSkillContext(db, 'instructions-received');
  assert.equal(received?.instructions.observable, true);
  if (!received?.instructions.observable) return;
  assert.deepEqual(
    received.instructions.occurrences.map(load => [load.filePath, load.loadReason]),
    [
      ['/work/AGENTS.md', 'session_start'],
      ['/work/AGENTS.md', 'compact'],
    ],
  );
  assert.deepEqual(
    getSessionSkillContext(db, 'instructions-undelivered')?.instructions,
    {
      observable: false,
      reason: 'instrumented_no_events_received',
      occurrences: [],
    },
  );
  assert.deepEqual(
    getSessionSkillContext(db, 'instructions-missing')?.instructions,
    {
      observable: false,
      reason: 'instruction_load_signal_absent',
      occurrences: [],
    },
  );
  assert.deepEqual(
    getSessionSkillContext(db, 'instructions-empty-codex')?.instructions,
    { observable: true, occurrences: [] },
  );
});

test('budget remains unknown for incompatible, stale, mismatched, or absent policy evidence', () => {
  const cases = [
    {
      id: 'budget-units',
      artifact: policy({ limitUnit: 'tokens' }),
      reason: 'incompatible_units',
    },
    {
      id: 'budget-stale',
      artifact: policy({
        observedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-07-01T00:00:00.000Z',
      }),
      reason: 'policy_not_fresh',
    },
    {
      id: 'budget-scope',
      artifact: policy({ harnessVersion: '0.144.0' }),
      reason: 'policy_scope_mismatch',
    },
  ] as const;

  for (const item of cases) {
    insertSession(item.id, 'codex', capabilities({
      catalog: { observable: true },
    }));
    insertObservation({
      sessionId: item.id,
      ordinal: 1,
      kind: 'catalog_presentation',
      observedAt: '2026-07-01T12:00:00.000Z',
      metadata: runtimeMetadata(),
      entries: [],
    });
    assert.equal(
      createExpectedRealization(
        db,
        realization(`expected-${item.id}`, item.artifact),
      ).ok,
      true,
    );
    assert.equal(
      associateExpectedRealization(db, item.id, `expected-${item.id}`).ok,
      true,
    );
    const projected = getSessionSkillContext(db, item.id);
    assert.equal(projected?.catalog.observable, true);
    if (!projected?.catalog.observable) continue;
    assert.deepEqual(projected.catalog.occurrences[0]?.budget, {
      status: 'unknown',
      reason: item.reason,
    });
  }

  insertSession('budget-absent', 'codex', capabilities({
    catalog: { observable: true },
  }), { endedAt: null });
  insertObservation({
    sessionId: 'budget-absent',
    ordinal: 1,
    kind: 'catalog_presentation',
    observedAt: '2026-07-01T12:00:00.000Z',
    metadata: runtimeMetadata(),
    entries: [],
  });
  const absent = getSessionSkillContext(db, 'budget-absent');
  assert.equal(absent?.endedAt, null);
  assert.equal(absent?.catalog.observable, true);
  if (!absent?.catalog.observable) return;
  assert.deepEqual(absent.catalog.occurrences[0]?.comparison, {
    status: 'unavailable',
    reason: 'no_expected_realization',
  });
  assert.deepEqual(absent.catalog.occurrences[0]?.budget, {
    status: 'unknown',
    reason: 'no_authoritative_limit',
  });
});

test('accepts an exact Codex model identifier as model-scoped budget authority', () => {
  const sessionId = 'budget-model-scope';
  insertSession(sessionId, 'codex', capabilities({
    catalog: { observable: true },
  }));
  const metadata = runtimeMetadata();
  const runtime = metadata['runtime'] as Record<string, unknown>;
  runtime['model'] = 'gpt-5.6-terra';
  insertObservation({
    sessionId,
    ordinal: 1,
    kind: 'catalog_presentation',
    observedAt: '2026-07-01T12:00:00.000Z',
    metadata,
    entries: [],
  });
  assert.equal(
    createExpectedRealization(
      db,
      realization(
        'expected-budget-model-scope',
        policy({
          model: 'gpt-5.6-terra',
          modelVersion: null,
        }),
      ),
    ).ok,
    true,
  );
  assert.equal(
    associateExpectedRealization(
      db,
      sessionId,
      'expected-budget-model-scope',
    ).ok,
    true,
  );

  const projected = getSessionSkillContext(db, sessionId);
  assert.equal(projected?.catalog.observable, true);
  if (!projected?.catalog.observable) return;
  assert.deepEqual(projected.catalog.occurrences[0]?.budget, {
    status: 'available',
    used: 128,
    limit: 256,
    ratio: 0.5,
    unit: 'utf8_bytes',
    measurementMethod: 'retained_catalog_block_utf8_bytes/v1',
    policyArtifactId: 'policy',
    policyArtifactRevision: 'r1',
    policyArtifactHash: 'a'.repeat(64),
  });
});

test('rejects a content-hashed realization with an incomplete policy artifact', () => {
  const sessionId = 'invalid-policy-realization';
  const realizationId = 'invalid-policy';
  insertSession(sessionId, 'codex', capabilities({
    catalog: { observable: true },
  }));
  insertObservation({
    sessionId,
    ordinal: 1,
    kind: 'catalog_presentation',
    observedAt: '2026-07-01T12:00:00.000Z',
    metadata: runtimeMetadata(),
    entries: [],
  });

  const payload = JSON.stringify({
    ...realization(realizationId),
    validTo: '2026-07-02T00:00:00.000Z',
    policyArtifacts: [{
      kind: 'vendor_policy_snapshot',
      artifactId: 'incomplete-policy',
    }],
  });
  db.prepare(`
    INSERT INTO skill_expected_realizations (
      id, harness, profile_identity, canonical_revision,
      valid_from, valid_to, payload_json, content_hash
    ) VALUES (?, 'codex', 'profile:core', 'dojo@revision', ?, ?, ?, ?)
  `).run(
    realizationId,
    '2026-07-01T00:00:00.000Z',
    '2026-07-02T00:00:00.000Z',
    payload,
    sha256(payload),
  );
  db.prepare(`
    INSERT INTO session_expected_skill_realizations (session_id, realization_id)
    VALUES (?, ?)
  `).run(sessionId, realizationId);

  const projected = getSessionSkillContext(db, sessionId);
  assert.deepEqual(projected?.expectedRealization, {
    status: 'unavailable',
    reason: 'invalid_expected_realization',
  });
  assert.equal(projected?.catalog.observable, true);
  if (!projected?.catalog.observable) return;
  assert.deepEqual(projected.catalog.occurrences[0]?.comparison, {
    status: 'unavailable',
    reason: 'invalid_expected_realization',
  });
  assert.deepEqual(projected.catalog.occurrences[0]?.budget, {
    status: 'unknown',
    reason: 'limit_authority_unrecognized',
  });
});

test('returns null for an unknown session', () => {
  assert.equal(getSessionSkillContext(db, 'missing-session'), null);
});
