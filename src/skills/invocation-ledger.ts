import type Database from 'better-sqlite3';
import type { AnalyticsParams } from '../api/v2/types.js';
import { config } from '../config.js';
import {
  ANTIGRAVITY_SKILL_TOOL_NAMES,
  extractAntigravitySkillNamesFromToolCall,
  extractCanonicalCodexSessionId,
  extractCodexCommandFromEventMetadata,
  extractCodexCommandFromInputJson,
  extractCodexSkillNamesFromCommand,
  extractExplicitSkillName,
  fingerprintAntigravitySkillCall,
  fingerprintCodexCommand,
  hasAntigravityNonZeroExit,
  isAntigravityShellTool,
} from './invocation-detection.js';
import { dateParamLowerBound, dateParamUpperExclusive, localDayOf } from '../util/local-day.js';
import { browserAgentName } from '../util/agent-identity.js';
import { sqlStringList } from '../util/sql-literals.js';
import { hasCurrentCodexContextEvidence } from './codex-evidence-version.js';

export type SkillInvocationDetectionSource =
  | 'explicit_skill_tool'
  | 'codex_otel'
  | 'codex_jsonl'
  | 'antigravity_transcript';

export interface SkillInvocationOccurrence {
  skillName: string;
  timestamp: string;
  project: string | null;
  harness: string;
  sessionId: string;
  canonicalSessionId: string;
  messageOrdinal: number | null;
  toolUseId: string | null;
  detectionSource: SkillInvocationDetectionSource;
  commandFingerprint: string | null;
  occurrenceIndex: number;
  matchedObservation: {
    id: number;
    sessionId: string;
    ordinal: number;
    projectIdentity: string | null;
  } | null;
  classificationCapability: {
    observable: boolean;
    reason?: string;
  };
}

/** Whether a local day falls inside the requested (local) date range. */
function isDateWithinRange(date: string, params: AnalyticsParams): boolean {
  if (params.date_from && date < params.date_from) return false;
  if (params.date_to && date > params.date_to) return false;
  return true;
}


function assignOccurrenceIndexes(
  occurrences: Omit<
    SkillInvocationOccurrence,
    'occurrenceIndex' | 'matchedObservation' | 'classificationCapability'
  >[],
): SkillInvocationOccurrence[] {
  const indexes = new Map<string, number>();
  return occurrences.map(occurrence => {
    const key = [
      occurrence.canonicalSessionId,
      occurrence.skillName,
      occurrence.commandFingerprint ?? '',
    ].join('\0');
    const occurrenceIndex = indexes.get(key) ?? 0;
    indexes.set(key, occurrenceIndex + 1);
    return {
      ...occurrence,
      occurrenceIndex,
      matchedObservation: null,
      classificationCapability: {
        observable: false,
        reason: 'missing_ordered_session_projection',
      },
    };
  });
}

interface StoredConsultationObservation {
  id: number;
  agent: string;
  session_id: string;
  ordinal: number;
  skill_name: string;
  command_fingerprint: string | null;
  project_identity: string | null;
  skill_context_capabilities_json: string | null;
}

function enrichWithOrderedObservations(
  db: Database.Database,
  occurrences: SkillInvocationOccurrence[],
  params: AnalyticsParams,
): void {
  const skillNames = [...new Set(occurrences.map(occurrence => occurrence.skillName))];
  if (skillNames.length === 0) return;
  const rows: StoredConsultationObservation[] = [];
  for (let offset = 0; offset < skillNames.length; offset += 500) {
    const chunk = skillNames.slice(offset, offset + 500);
    const filters = [
      "observation.kind = 'consultation'",
      `observation.skill_name IN (${chunk.map(() => '?').join(', ')})`,
    ];
    const values: unknown[] = [...chunk];
    if (params.project) {
      filters.push('session.project = ?');
      values.push(params.project);
    }
    if (params.agent) {
      filters.push('session.agent = ?');
      values.push(browserAgentName(params.agent));
    }
    if (params.date_from) {
      filters.push('datetime(observation.observed_at) >= datetime(?)');
      values.push(dateParamLowerBound(params.date_from));
    }
    const observationToExclusive = params.date_to
      ? dateParamUpperExclusive(params.date_to)
      : null;
    if (observationToExclusive) {
      filters.push('datetime(observation.observed_at) < datetime(?)');
      values.push(observationToExclusive);
    }
    rows.push(...db.prepare(`
      SELECT
        observation.id,
        observation.session_id,
        observation.ordinal,
        observation.skill_name,
        observation.command_fingerprint,
        observation.project_identity,
        session.agent,
        session.skill_context_capabilities_json
      FROM session_context_observations observation
      JOIN browsing_sessions session ON session.id = observation.session_id
      WHERE ${filters.join(' AND ')}
      ORDER BY observation.session_id, observation.ordinal, observation.id
    `).all(...values) as StoredConsultationObservation[]);
  }

  const indexes = new Map<string, number>();
  const candidates = new Map<string, StoredConsultationObservation[]>();
  const currentBySession = new Map<string, boolean>();
  const unverifiedSessions = new Set<string>();
  for (const row of rows) {
    const canonicalSessionId = extractCanonicalCodexSessionId(row.session_id);
    if (row.agent === 'codex') {
      const current = currentBySession.get(row.session_id)
        ?? hasCurrentCodexContextEvidence(row.skill_context_capabilities_json);
      currentBySession.set(row.session_id, current);
      if (!current) {
        unverifiedSessions.add(canonicalSessionId);
        continue;
      }
    }
    const baseKey = [
      canonicalSessionId,
      row.skill_name,
      row.command_fingerprint ?? '',
    ].join('\0');
    const index = indexes.get(baseKey) ?? 0;
    indexes.set(baseKey, index + 1);
    const key = `${baseKey}\0${index}`;
    const group = candidates.get(key) ?? [];
    group.push(row);
    candidates.set(key, group);
  }

  for (const occurrence of occurrences) {
    const key = [
      occurrence.canonicalSessionId,
      occurrence.skillName,
      occurrence.commandFingerprint ?? '',
      occurrence.occurrenceIndex,
    ].join('\0');
    const matches = candidates.get(key) ?? [];
    if (matches.length !== 1) {
      if (occurrence.harness === 'codex' && unverifiedSessions.has(occurrence.canonicalSessionId)) {
        occurrence.classificationCapability = { observable: false, reason: 'codex_context_evidence_unverified' };
      }
      continue;
    }
    const match = matches[0]!;
    let observable = true;
    let reason: string | undefined;
    try {
      const capabilities = JSON.parse(
        match.skill_context_capabilities_json ?? '{}',
      ) as { orderedConsultations?: { observable?: boolean; reason?: string };
        compactionVisibility?: { observable?: boolean; reason?: string } };
      if (capabilities.orderedConsultations?.observable !== true) {
        observable = false;
        reason = capabilities.orderedConsultations?.reason
          ?? 'consultation_detection_unavailable';
      } else if (capabilities.compactionVisibility?.observable !== true) {
        observable = false;
        reason = capabilities.compactionVisibility?.reason
          ?? 'compaction_visibility_unavailable';
      }
    } catch {
      observable = false;
      reason = 'missing_ordered_session_projection';
    }
    occurrence.matchedObservation = {
      id: match.id,
      sessionId: match.session_id,
      ordinal: match.ordinal,
      projectIdentity: match.project_identity,
    };
    occurrence.classificationCapability = observable
      ? { observable: true }
      : { observable: false, reason };
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Consume one count for `key`; false when none remain. */
function take(counts: Map<string, number>, key: string): boolean {
  const remaining = counts.get(key) ?? 0;
  if (remaining === 0) return false;
  counts.set(key, remaining - 1);
  return true;
}

/**
 * The windowed Codex skill-event read: exec tool calls whose command touched a
 * SKILL.md. Shared with a plan test, since an agent_type-only seek here reads
 * every Codex event instead of only its exec tool calls.
 */
export function codexSkillEventStatement(params: AnalyticsParams): { sql: string; values: unknown[] } {
  const eventFilters = [
    "agent_type = 'codex'",
    "event_type = 'tool_use'",
    "tool_name IN ('exec_command', 'exec')",
    "metadata LIKE '%SKILL.md%'",
  ];
  const eventValues: unknown[] = [];
  if (params.project) {
    eventFilters.push('project = ?');
    eventValues.push(params.project);
  }
  if (params.date_from) {
    eventFilters.push('datetime(COALESCE(client_timestamp, created_at)) >= datetime(?)');
    eventValues.push(dateParamLowerBound(params.date_from));
  }
  const eventToExclusive = params.date_to ? dateParamUpperExclusive(params.date_to) : null;
  if (eventToExclusive) {
    eventFilters.push('datetime(COALESCE(client_timestamp, created_at)) < datetime(?)');
    eventValues.push(eventToExclusive);
  }
  return {
    sql: `
      SELECT
        id,
        session_id,
        project,
        COALESCE(client_timestamp, created_at) AS timestamp,
        metadata
      FROM events
      WHERE ${eventFilters.join(' AND ')}
      ORDER BY timestamp, id
    `,
    values: eventValues,
  };
}

/**
 * Canonical phase-1 invocation selection.
 *
 * Codex OTEL reads suppress JSONL reads of the same skill in the same session,
 * one for one, and only after the OTEL row passes project and date filters and
 * yields at least one concrete skill path. This matches
 * health's historical behavior and intentionally corrects daily's old
 * out-of-window suppression bug.
 */
export function selectSkillInvocationOccurrences(
  db: Database.Database,
  params: AnalyticsParams = {},
): SkillInvocationOccurrence[] {
  if (params.agent) params = { ...params, agent: browserAgentName(params.agent) };
  const occurrences: Omit<
    SkillInvocationOccurrence,
    'occurrenceIndex' | 'matchedObservation' | 'classificationCapability'
  >[] = [];

  const explicitFilters = [
    "tc.tool_name = 'Skill'",
    'tc.input_json IS NOT NULL',
  ];
  const explicitValues: unknown[] = [];
  if (params.project) {
    explicitFilters.push('bs.project = ?');
    explicitValues.push(params.project);
  }
  if (params.agent) {
    explicitFilters.push('bs.agent = ?');
    explicitValues.push(params.agent);
  }
  if (params.date_from) {
    explicitFilters.push('datetime(COALESCE(m.timestamp, bs.started_at)) >= datetime(?)');
    explicitValues.push(dateParamLowerBound(params.date_from));
  }
  const explicitToExclusive = params.date_to ? dateParamUpperExclusive(params.date_to) : null;
  if (explicitToExclusive) {
    explicitFilters.push('datetime(COALESCE(m.timestamp, bs.started_at)) < datetime(?)');
    explicitValues.push(explicitToExclusive);
  }
  const explicitRows = db.prepare(`
    SELECT
      tc.session_id,
      COALESCE(m.timestamp, bs.started_at) AS timestamp,
      bs.project,
      bs.agent,
      m.ordinal,
      tc.tool_use_id,
      tc.input_json
    FROM tool_calls tc
    JOIN browsing_sessions bs ON bs.id = tc.session_id
    LEFT JOIN messages m ON m.id = tc.message_id
    WHERE ${explicitFilters.join(' AND ')}
    ORDER BY timestamp, tc.id
  `).all(...explicitValues) as Array<{
    session_id: string;
    timestamp: string | null;
    project: string | null;
    agent: string;
    ordinal: number | null;
    tool_use_id: string | null;
    input_json: string | null;
  }>;

  for (const row of explicitRows) {
    if (params.project && row.project !== params.project) continue;
    if (params.agent && row.agent !== params.agent) continue;
    if (!row.timestamp || !isDateWithinRange(localDayOf(row.timestamp) ?? row.timestamp.slice(0, 10), params)) continue;
    const skillName = extractExplicitSkillName(row.input_json);
    if (!skillName) continue;
    occurrences.push({
      skillName,
      timestamp: row.timestamp,
      project: row.project,
      harness: row.agent,
      sessionId: row.session_id,
      canonicalSessionId: row.session_id,
      messageOrdinal: row.ordinal,
      toolUseId: row.tool_use_id,
      detectionSource: 'explicit_skill_tool',
      commandFingerprint: null,
    });
  }

  if (!params.agent || params.agent === 'codex') {
    const statement = codexSkillEventStatement(params);
    const eventRows = db.prepare(statement.sql).all(...statement.values) as Array<{
      id: number;
      session_id: string;
      project: string | null;
      timestamp: string | null;
      metadata: string | null;
    }>;

    // WHY: One session can use skills missing from its OTEL stream; reconcile by skill instead of
    // suppressing all JSONL evidence.
    const otelReadsBySkill = new Map<string, number>();
    const otelReadsByCommand = new Map<string, number>();
    for (const row of eventRows) {
      if (params.project && row.project !== params.project) continue;
      if (!row.timestamp || !isDateWithinRange(localDayOf(row.timestamp) ?? row.timestamp.slice(0, 10), params)) continue;
      const command = extractCodexCommandFromEventMetadata(row.metadata);
      if (!command) continue;
      const skillNames = extractCodexSkillNamesFromCommand(command);
      if (skillNames.length === 0) continue;
      const canonicalSessionId = extractCanonicalCodexSessionId(row.session_id);
      const commandFingerprint = fingerprintCodexCommand(command);
      for (const skillName of skillNames) {
        increment(otelReadsBySkill, `${canonicalSessionId}|${skillName}`);
        increment(otelReadsByCommand, `${canonicalSessionId}|${skillName}|${commandFingerprint}`);
        occurrences.push({
          skillName,
          timestamp: row.timestamp,
          project: row.project,
          harness: 'codex',
          sessionId: row.session_id,
          canonicalSessionId,
          messageOrdinal: null,
          toolUseId: null,
          detectionSource: 'codex_otel',
          commandFingerprint,
        });
      }
    }

    const jsonlFilters = [
      "bs.agent = 'codex'",
      "bs.integration_mode = 'codex-jsonl'",
      "tc.tool_name IN ('exec_command', 'exec')",
      'tc.input_json IS NOT NULL',
      "tc.input_json LIKE '%SKILL.md%'",
    ];
    const jsonlValues: unknown[] = [];
    if (params.project) {
      jsonlFilters.push('bs.project = ?');
      jsonlValues.push(params.project);
    }
    if (params.date_from) {
      jsonlFilters.push('datetime(COALESCE(m.timestamp, bs.started_at)) >= datetime(?)');
      jsonlValues.push(dateParamLowerBound(params.date_from));
    }
    const jsonlToExclusive = params.date_to ? dateParamUpperExclusive(params.date_to) : null;
    if (jsonlToExclusive) {
      jsonlFilters.push('datetime(COALESCE(m.timestamp, bs.started_at)) < datetime(?)');
      jsonlValues.push(jsonlToExclusive);
    }
    const jsonlRows = db.prepare(`
      SELECT
        tc.id,
        bs.id AS session_id,
        bs.project,
        COALESCE(m.timestamp, bs.started_at) AS timestamp,
        m.ordinal,
        tc.input_json
      FROM tool_calls tc
      JOIN browsing_sessions bs ON bs.id = tc.session_id
      LEFT JOIN messages m ON m.id = tc.message_id
      WHERE ${jsonlFilters.join(' AND ')}
      ORDER BY timestamp, tc.id
    `).all(...jsonlValues) as Array<{
      id: number;
      session_id: string;
      project: string | null;
      timestamp: string | null;
      ordinal: number | null;
      input_json: string | null;
    }>;

    const jsonlReads: Array<typeof occurrences[number] & { matched: boolean }> = [];
    for (const row of jsonlRows) {
      if (params.project && row.project !== params.project) continue;
      if (!row.timestamp || !isDateWithinRange(localDayOf(row.timestamp) ?? row.timestamp.slice(0, 10), params)) continue;
      const command = extractCodexCommandFromInputJson(row.input_json);
      if (!command) continue;
      const canonicalSessionId = extractCanonicalCodexSessionId(row.session_id);
      const commandFingerprint = fingerprintCodexCommand(command);
      for (const skillName of extractCodexSkillNamesFromCommand(command)) {
        jsonlReads.push({
          skillName,
          timestamp: row.timestamp,
          project: row.project,
          harness: 'codex',
          sessionId: row.session_id,
          canonicalSessionId,
          messageOrdinal: row.ordinal,
          toolUseId: null,
          detectionSource: 'codex_jsonl',
          commandFingerprint,
          matched: false,
        });
      }
    }

    // WHY: Older and newer rollouts can spell the same execution command differently.
    for (const read of jsonlReads) {
      const skillKey = `${read.canonicalSessionId}|${read.skillName}`;
      if (take(otelReadsByCommand, `${skillKey}|${read.commandFingerprint}`)) {
        take(otelReadsBySkill, skillKey);
        read.matched = true;
      }
    }
    for (const { matched, ...read } of jsonlReads) {
      if (matched || take(otelReadsBySkill, `${read.canonicalSessionId}|${read.skillName}`)) continue;
      occurrences.push(read);
    }
  }

  if (!params.agent || params.agent === 'antigravity') {
    const agrFilters = [
      "bs.agent = 'antigravity'",
      `tc.tool_name IN (${sqlStringList(ANTIGRAVITY_SKILL_TOOL_NAMES)})`,
      'tc.input_json IS NOT NULL',
      "tc.input_json LIKE '%SKILL.md%'",
      'tc.tool_use_id IS NOT NULL',
      `(
        EXISTS (
          SELECT 1 FROM session_items si
          WHERE si.session_id = tc.session_id
            AND si.kind = 'tool_result'
            AND si.source_item_id = tc.tool_use_id
            AND si.status = 'success'
        )
        OR EXISTS (
          SELECT 1 FROM messages rm
          WHERE rm.session_id = tc.session_id
            AND rm.role = 'user'
            AND rm.content LIKE '%"type":"tool_result"%'
            AND json_valid(rm.content)
            AND EXISTS (
              SELECT 1 FROM json_each(rm.content) block
              WHERE json_extract(block.value, '$.type') = 'tool_result'
                AND json_extract(block.value, '$.tool_use_id') = tc.tool_use_id
                AND COALESCE(json_extract(block.value, '$.is_error'), 0) = 0
                AND COALESCE(json_extract(block.value, '$.outcome'), '') != 'unrecorded'
            )
        )
      )`,
    ];
    const agrValues: unknown[] = [];
    if (params.project) {
      agrFilters.push('bs.project = ?');
      agrValues.push(params.project);
    }
    if (params.date_from) {
      agrFilters.push('datetime(COALESCE(m.timestamp, bs.started_at)) >= datetime(?)');
      agrValues.push(dateParamLowerBound(params.date_from));
    }
    const agrToExclusive = params.date_to ? dateParamUpperExclusive(params.date_to) : null;
    if (agrToExclusive) {
      agrFilters.push('datetime(COALESCE(m.timestamp, bs.started_at)) < datetime(?)');
      agrValues.push(agrToExclusive);
    }
    const agrRows = db.prepare(`
      SELECT
        tc.id,
        bs.id AS session_id,
        bs.project,
        bs.cwd,
        COALESCE(m.timestamp, bs.started_at) AS timestamp,
        m.ordinal,
        tc.tool_name,
        tc.tool_use_id,
        tc.input_json,
        (
          SELECT si.payload_json
          FROM session_items si
          WHERE si.session_id = tc.session_id
            AND si.kind = 'tool_result'
            AND si.source_item_id = tc.tool_use_id
            AND si.status = 'success'
          LIMIT 1
        ) AS item_result_payload,
        (
          SELECT json_extract(block.value, '$.content')
          FROM messages rm, json_each(rm.content) block
          WHERE rm.session_id = tc.session_id
            AND rm.role = 'user'
            AND rm.content LIKE '%"type":"tool_result"%'
            AND json_valid(rm.content)
            AND json_extract(block.value, '$.type') = 'tool_result'
            AND json_extract(block.value, '$.tool_use_id') = tc.tool_use_id
            AND COALESCE(json_extract(block.value, '$.is_error'), 0) = 0
            AND COALESCE(json_extract(block.value, '$.outcome'), '') != 'unrecorded'
          LIMIT 1
        ) AS msg_result_content
      FROM tool_calls tc
      JOIN browsing_sessions bs ON bs.id = tc.session_id
      LEFT JOIN messages m ON m.id = tc.message_id
      WHERE ${agrFilters.join(' AND ')}
      ORDER BY timestamp, tc.id
    `).all(...agrValues) as Array<{
      id: number;
      session_id: string;
      project: string | null;
      cwd: string | null;
      timestamp: string | null;
      ordinal: number | null;
      tool_name: string;
      tool_use_id: string | null;
      input_json: string | null;
      item_result_payload: string | null;
      msg_result_content: string | null;
    }>;

    const extractResultText = (itemPayload: string | null, msgContent: string | null): string => {
      if (itemPayload) {
        try {
          const parsed = JSON.parse(itemPayload) as { content?: unknown };
          if (typeof parsed.content === 'string') return parsed.content;
        } catch {
          return itemPayload;
        }
      }
      return msgContent ?? '';
    };

    const seenToolCalls = new Set<string>();
    for (const row of agrRows) {
      if (params.project && row.project !== params.project) continue;
      if (!row.timestamp || !isDateWithinRange(localDayOf(row.timestamp) ?? row.timestamp.slice(0, 10), params)) continue;
      if (isAntigravityShellTool(row.tool_name)) {
        const resultText = extractResultText(row.item_result_payload, row.msg_result_content);
        if (hasAntigravityNonZeroExit(resultText)) continue;
      }
      const skillNames = extractAntigravitySkillNamesFromToolCall(row.tool_name, row.input_json, {
        cwd: row.cwd,
        extraRoots: config.skillCatalogDirs,
      });
      if (skillNames.length === 0) continue;
      const commandFingerprint = fingerprintAntigravitySkillCall(row.tool_name, row.input_json, {
        cwd: row.cwd,
      });
      for (const skillName of skillNames) {
        const dedupeKey = `${row.session_id}\0${row.tool_use_id ?? row.id}\0${skillName}`;
        if (seenToolCalls.has(dedupeKey)) continue;
        seenToolCalls.add(dedupeKey);
        occurrences.push({
          skillName,
          timestamp: row.timestamp,
          project: row.project,
          harness: 'antigravity',
          sessionId: row.session_id,
          canonicalSessionId: row.session_id,
          messageOrdinal: row.ordinal,
          toolUseId: row.tool_use_id,
          detectionSource: 'antigravity_transcript',
          commandFingerprint,
        });
      }
    }
  }

  const selected = assignOccurrenceIndexes(occurrences);
  enrichWithOrderedObservations(db, selected, params);
  return selected;
}
