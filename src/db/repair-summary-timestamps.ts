import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

type Change = { table: string; id: string | number; column: string; before: string; after: string };
type Event = { id: number; event_id: string | null; client_timestamp: string | null;
  created_at: string; agent_type: string; source: string };
type Turn = { id: number; source_turn_id: string; started_at: string | null; ended_at: string | null };
const NAIVE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function inventory(db: Database.Database) {
  const changes: Change[] = [];
  let unresolvedFields = 0;
  const sessions = db.prepare(`SELECT id, started_at, ended_at, last_item_at FROM browsing_sessions
    WHERE agent='codex' AND fidelity='summary' AND file_path IS NULL
      AND integration_mode IN ('codex-otel','codex-import','codex-summary') ORDER BY id`).all() as
    Array<{ id: string; started_at: string | null; ended_at: string | null; last_item_at: string | null }>;
  const eventQuery = db.prepare(`SELECT id,event_id,client_timestamp,created_at,agent_type,source
    FROM events WHERE session_id=? ORDER BY id`);
  const turnQuery = db.prepare('SELECT id,source_turn_id,started_at,ended_at FROM session_turns WHERE session_id=? ORDER BY id');
  const itemQuery = db.prepare('SELECT id,turn_id,created_at FROM session_items WHERE session_id=? ORDER BY id');
  const add = (table: string, id: string | number, column: string, value: string | null, proven: boolean) => {
    if (!value || !NAIVE.test(value)) return;
    if (!proven) { unresolvedFields++; return; }
    changes.push({ table, id, column, before: value, after: `${value.replace(' ', 'T')}Z` });
  };
  for (const session of sessions) {
    const events = eventQuery.all(session.id) as Event[];
    const turns = turnQuery.all(session.id) as Turn[];
    const bySource = new Map<string, Event[]>();
    for (const event of events) {
      const key = event.event_id ?? `codex-event:${event.id}`;
      bySource.set(key, [...(bySource.get(key) ?? []), event]);
    }
    const fallback = (e: Event) => e.client_timestamp === null && e.agent_type === 'codex'
      && ['otel', 'import', 'hook', 'api'].includes(e.source) && NAIVE.test(e.created_at);
    const linked = new Map<number, Event>();
    for (const turn of turns) {
      const matches = bySource.get(turn.source_turn_id) ?? [];
      if (matches.length === 1 && fallback(matches[0])) linked.set(turn.id, matches[0]);
    }
    const provenTime = (value: string | null) => value !== null
      && [...linked.values()].some(e => e.created_at === value)
      && !events.some(e => (e.client_timestamp ?? e.created_at) === value && !fallback(e));
    for (const column of ['started_at', 'ended_at', 'last_item_at'] as const) {
      const value = session[column];
      // The retained session start must additionally match the first source event.
      const firstMatches = column !== 'started_at'
        || (events.length > 0 && fallback(events[0]) && events[0].created_at === value);
      add('browsing_sessions', session.id, column, value, provenTime(value) && firstMatches);
    }
    for (const turn of turns) {
      const event = linked.get(turn.id);
      for (const column of ['started_at', 'ended_at'] as const) {
        add('session_turns', turn.id, column, turn[column], !!event && event.created_at === turn[column]);
      }
    }
    for (const item of itemQuery.all(session.id) as Array<{ id: number; turn_id: number; created_at: string | null }>) {
      const event = linked.get(item.turn_id);
      add('session_items', item.id, 'created_at', item.created_at, !!event && event.created_at === item.created_at);
    }
  }
  return { changes, unresolvedFields };
}

export function repairSummaryTimestamps(db: Database.Database, expectedDigest?: string) {
  const run = db.transaction(() => {
    const plan = inventory(db);
    const digest = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    if (expectedDigest !== undefined && expectedDigest !== digest) throw new Error('Repair inventory changed; preview again');
    const byTable: Record<string, number> = {};
    for (const change of plan.changes) {
      byTable[change.table] = (byTable[change.table] ?? 0) + 1;
      if (expectedDigest !== undefined) {
        // Table/column names come only from the closed inventory above, never CLI input.
        const result = db.prepare(`UPDATE ${change.table} SET ${change.column}=? WHERE id=? AND ${change.column}=?`)
          .run(change.after, change.id, change.before);
        if (result.changes !== 1) throw new Error('Repair row changed; transaction rolled back');
      }
    }
    return { digest, changes: plan.changes.length, byTable, unresolvedFields: plan.unresolvedFields,
      applied: expectedDigest !== undefined };
  });
  return expectedDigest === undefined ? run.deferred() : run.immediate();
}
