import type Database from 'better-sqlite3';
import type { AnalyticsParams, SkillConsultationAnalytics, SkillConsultationClass, SkillConsultationClassCounts, SkillConsultationRow } from '../api/v2/types.js';
import { resolveVersionAt, type CatalogSnapshot } from './catalog.js';
import { selectSkillInvocationOccurrences, type SkillInvocationOccurrence } from './invocation-ledger.js';

interface SessionRow {
  id: string;
  agent: string;
  project: string | null;
  project_identity: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_item_at: string | null;
  skill_context_capabilities_json: string | null;
}

interface StoredObservation {
  id: number;
  session_id: string;
  ordinal: number;
  kind: string;
}

const emptyClasses = (): SkillConsultationClassCounts => ({
  first_read: 0,
  rehydration_after_compaction: 0,
  repeat_no_compaction: 0,
  unclassifiable: 0,
});

function utcBoundary(date: string | undefined, addDay: boolean): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (addDay) parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString();
}

function overlapsWindow(
  session: SessionRow,
  from: string | null,
  toExclusive: string | null,
  asOf: string,
): boolean | null {
  const start = session.started_at;
  const end = session.ended_at ?? session.last_item_at ?? (start ? asOf : null);
  if (!start || !end) return null;
  return (!toExclusive || start < toExclusive) && (!from || end >= from);
}

function capability(
  session: SessionRow,
): { observable: boolean; reason?: string } {
  if (!session.skill_context_capabilities_json) {
    return { observable: false, reason: 'missing_ordered_session_projection' };
  }
  try {
    const parsed = JSON.parse(session.skill_context_capabilities_json) as {
      orderedConsultations?: { observable?: boolean; reason?: string };
      compactionVisibility?: { observable?: boolean; reason?: string };
    };
    if (parsed.orderedConsultations?.observable !== true) {
      return {
        observable: false,
        reason: parsed.orderedConsultations?.reason ?? 'consultation_detection_unavailable',
      };
    }
    if (parsed.compactionVisibility?.observable !== true) {
      return {
        observable: false,
        reason: parsed.compactionVisibility?.reason ?? 'compaction_visibility_unavailable',
      };
    }
    return { observable: true };
  } catch {
    return { observable: false, reason: 'missing_ordered_session_projection' };
  }
}

function classifyOccurrences(
  occurrences: SkillInvocationOccurrence[],
  observations: StoredObservation[],
): Map<SkillInvocationOccurrence, SkillConsultationClass> {
  const compactions = new Map<string, number[]>();
  for (const observation of observations) {
    if (observation.kind !== 'compaction') continue;
    const values = compactions.get(observation.session_id) ?? [];
    values.push(observation.ordinal);
    compactions.set(observation.session_id, values);
  }
  const classes = new Map<SkillInvocationOccurrence, SkillConsultationClass>();
  const lastGeneration = new Map<string, number>();
  const sorted = [...occurrences].sort((left, right) => {
    const sessionOrder = left.sessionId.localeCompare(right.sessionId);
    if (sessionOrder !== 0) return sessionOrder;
    return (left.matchedObservation?.ordinal ?? Number.MAX_SAFE_INTEGER)
      - (right.matchedObservation?.ordinal ?? Number.MAX_SAFE_INTEGER);
  });
  for (const occurrence of sorted) {
    if (!occurrence.matchedObservation || !occurrence.classificationCapability.observable) {
      classes.set(occurrence, 'unclassifiable');
      continue;
    }
    const generation = (compactions.get(occurrence.sessionId) ?? [])
      .filter(ordinal => ordinal < occurrence.matchedObservation!.ordinal).length;
    const key = `${occurrence.sessionId}\0${occurrence.skillName}`;
    const previous = lastGeneration.get(key);
    if (previous === undefined) {
      classes.set(occurrence, 'first_read');
    } else if (generation > previous) {
      classes.set(occurrence, 'rehydration_after_compaction');
    } else {
      classes.set(occurrence, 'repeat_no_compaction');
    }
    lastGeneration.set(key, generation);
  }
  return classes;
}

interface MutableAggregate {
  row: SkillConsultationRow;
  firstReadSessions: Set<string>;
  projects: Map<string, { label: string; sessions: Set<string> }>;
  versions: Map<string, {
    version: string | null;
    attribution: 'exact' | 'approximate' | 'unknown';
    invocations: number;
    classes: SkillConsultationClassCounts;
  }>;
}

export function getSkillConsultationAnalytics(
  db: Database.Database,
  params: AnalyticsParams,
  snapshots: CatalogSnapshot[],
  now = new Date(),
): SkillConsultationAnalytics {
  const asOf = now.toISOString();
  const from = utcBoundary(params.date_from, false);
  const toExclusive = utcBoundary(params.date_to, true);
  const occurrences = selectSkillInvocationOccurrences(db, params);
  const observations = db.prepare(`
    SELECT id, session_id, ordinal, kind
    FROM session_context_observations
    ORDER BY session_id, ordinal, id
  `).all() as StoredObservation[];
  const classes = classifyOccurrences(occurrences, observations);
  const sessions = (db.prepare(`
    SELECT id, agent, project, project_identity, started_at, ended_at,
           last_item_at, skill_context_capabilities_json
    FROM browsing_sessions
  `).all() as SessionRow[]).filter(session => {
    if (params.agent && session.agent !== params.agent) return false;
    if (params.project && session.project !== params.project) return false;
    return true;
  });

  const occurrenceSessions = new Set(occurrences.map(occurrence => occurrence.sessionId));
  let windowMembershipUnobservable = 0;
  const windowSessions = sessions.filter(session => {
    const overlap = overlapsWindow(session, from, toExclusive, asOf);
    if (overlap === null) {
      if (!occurrenceSessions.has(session.id)) windowMembershipUnobservable++;
      return occurrenceSessions.has(session.id);
    }
    return overlap || occurrenceSessions.has(session.id);
  });
  const sessionsByHarness = new Map<string, SessionRow[]>();
  for (const session of windowSessions) {
    const list = sessionsByHarness.get(session.agent) ?? [];
    list.push(session);
    sessionsByHarness.set(session.agent, list);
  }

  const aggregates = new Map<string, MutableAggregate>();
  const aggregateFor = (harness: string, name: string): MutableAggregate => {
    const key = `${harness}\0${name}`;
    const existing = aggregates.get(key);
    if (existing) return existing;
    const harnessSessions = sessionsByHarness.get(harness) ?? [];
    const eligible = harnessSessions.filter(session => capability(session).observable);
    const reasons = new Map<string, number>();
    for (const session of harnessSessions) {
      const state = capability(session);
      if (!state.observable) {
        const reason = state.reason ?? 'missing_ordered_session_projection';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
    const created: MutableAggregate = {
      row: {
        name,
        harness,
        invocations: 0,
        classes: emptyClasses(),
        sessionsInWindow: harnessSessions.length,
        eligibleSessionsInWindow: eligible.length,
        sessionsWithFirstRead: 0,
        firstReadEngagementRate: null,
        ineligibleSessionsByReason: [...reasons].map(([reason, count]) => ({ reason, sessions: count })),
        projectBreadth: { distinctObservedProjects: 0, sessions: [] },
        versions: [],
        exposure: {
          jointlyEligiblePresentedSessions: 0,
          presentedWithFirstRead: 0,
          presentedWithoutFirstRead: 0,
        },
      },
      firstReadSessions: new Set(),
      projects: new Map(),
      versions: new Map(),
    };
    aggregates.set(key, created);
    return created;
  };

  for (const occurrence of occurrences) {
    const aggregate = aggregateFor(occurrence.harness, occurrence.skillName);
    const classification = classes.get(occurrence) ?? 'unclassifiable';
    aggregate.row.invocations++;
    aggregate.row.classes[classification]++;
    if (classification === 'first_read') {
      aggregate.firstReadSessions.add(occurrence.sessionId);
      const identity = occurrence.matchedObservation?.projectIdentity ?? 'unknown';
      const session = sessions.find(candidate => candidate.id === occurrence.sessionId);
      const label = identity === 'unknown' ? 'Unknown' : (session?.project ?? identity);
      const bucket = aggregate.projects.get(identity) ?? { label, sessions: new Set<string>() };
      bucket.sessions.add(occurrence.sessionId);
      aggregate.projects.set(identity, bucket);
    }
    const resolved = resolveVersionAt(snapshots, occurrence.skillName, occurrence.timestamp);
    const attribution = resolved.version === null
      ? 'unknown'
      : resolved.approximate ? 'approximate' : 'exact';
    const versionKey = `${resolved.version ?? ''}\0${attribution}`;
    const version = aggregate.versions.get(versionKey) ?? {
      version: resolved.version,
      attribution,
      invocations: 0,
      classes: emptyClasses(),
    };
    version.invocations++;
    version.classes[classification]++;
    aggregate.versions.set(versionKey, version);
  }

  const presentationRows = db.prepare(`
    SELECT observation.session_id, entry.skill_name
    FROM session_context_observations observation
    JOIN session_catalog_observation_entries entry ON entry.observation_id = observation.id
    WHERE observation.kind = 'catalog_presentation'
    GROUP BY observation.session_id, entry.skill_name
  `).all() as Array<{ session_id: string; skill_name: string }>;
  const presented = new Map<string, Set<string>>();
  for (const row of presentationRows) {
    const set = presented.get(row.skill_name) ?? new Set<string>();
    set.add(row.session_id);
    presented.set(row.skill_name, set);
  }

  for (const aggregate of aggregates.values()) {
    aggregate.row.sessionsWithFirstRead = aggregate.firstReadSessions.size;
    aggregate.row.firstReadEngagementRate = aggregate.row.eligibleSessionsInWindow > 0
      ? aggregate.firstReadSessions.size / aggregate.row.eligibleSessionsInWindow
      : null;
    aggregate.row.projectBreadth.sessions = [...aggregate.projects.entries()]
      .map(([id, value]) => ({ id, label: value.label, sessions: value.sessions.size }))
      .sort((left, right) => right.sessions - left.sessions || left.label.localeCompare(right.label));
    aggregate.row.projectBreadth.distinctObservedProjects = aggregate.row.projectBreadth.sessions
      .filter(project => project.id !== 'unknown').length;
    aggregate.row.versions = [...aggregate.versions.values()];
    const eligibleIds = new Set(
      (sessionsByHarness.get(aggregate.row.harness) ?? [])
        .filter(session => capability(session).observable)
        .map(session => session.id),
    );
    const presentedIds = [...(presented.get(aggregate.row.name) ?? [])]
      .filter(sessionId => eligibleIds.has(sessionId));
    aggregate.row.exposure.jointlyEligiblePresentedSessions = presentedIds.length;
    aggregate.row.exposure.presentedWithFirstRead = presentedIds
      .filter(sessionId => aggregate.firstReadSessions.has(sessionId)).length;
    aggregate.row.exposure.presentedWithoutFirstRead =
      presentedIds.length - aggregate.row.exposure.presentedWithFirstRead;
  }

  const harnesses = [...new Set([
    ...sessionsByHarness.keys(),
    ...occurrences.map(occurrence => occurrence.harness),
  ])].sort();
  return {
    asOf,
    windowSemantics: {
      interval: 'utc_half_open',
      from,
      toExclusive,
      sessionMembership: 'observed_interval_overlap_or_in_window_occurrence',
      windowMembershipUnobservable,
    },
    byHarness: harnesses.map(harness => ({
      harness,
      detectionSemantics: harness === 'claude'
        ? 'explicit_skill_tool'
        : 'concrete_skill_path',
      skills: [...aggregates.values()]
        .filter(aggregate => aggregate.row.harness === harness)
        .map(aggregate => aggregate.row)
        .sort((left, right) => right.invocations - left.invocations || left.name.localeCompare(right.name)),
    })),
    comparability: harnesses.length <= 1
      ? { status: 'single_harness', limitingEvidence: [] }
      : {
          status: 'not_directly_comparable',
          limitingEvidence: ['different_detection_semantics'],
        },
  };
}
