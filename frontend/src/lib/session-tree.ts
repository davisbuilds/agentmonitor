import type { BrowsingSession } from './api/client';

export interface SessionTreeNode<S> {
  session: S;
  depth: number;
}

type SessionIdentity = Pick<BrowsingSession, 'id' | 'agent' | 'integration_mode' | 'parent_session_id'>;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CODEX_ROLLOUT_RE = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})$`, 'i');
const CODEX_UUID_RE = new RegExp(`^${UUID}$`, 'i');
const CODEX_TELEMETRY_MODES = new Set(['codex-import', 'codex-otel', 'codex-summary']);

/**
 * The session a row stands for. Mirrors browserSessionKey in the server's
 * session queries: a Codex rollout transcript and the telemetry row under its
 * native UUID are one session, which is how Codex subagents name their parent.
 */
export function sessionKey(session: SessionIdentity): string {
  if (session.agent !== 'codex') return session.id;
  const rollout = CODEX_ROLLOUT_RE.exec(session.id);
  if (rollout && session.integration_mode === 'codex-jsonl') return rollout[1].toLowerCase();
  if (CODEX_UUID_RE.test(session.id) && CODEX_TELEMETRY_MODES.has(session.integration_mode ?? '')) {
    return session.id.toLowerCase();
  }
  return session.id;
}

function parentKey(session: SessionIdentity): string | null {
  if (!session.parent_session_id) return null;
  return session.agent === 'codex' ? session.parent_session_id.toLowerCase() : session.parent_session_id;
}

/** Order sessions depth-first, each subagent under its parent when the parent is listed. */
export function buildSessionTree<S extends SessionIdentity>(source: readonly S[]): SessionTreeNode<S>[] {
  const listed = new Set(source.map(session => `${session.agent}\0${sessionKey(session)}`));
  const childrenByParent = new Map<string, S[]>();
  const roots: S[] = [];
  for (const session of source) {
    const parent = parentKey(session);
    const key = parent === null ? null : `${session.agent}\0${parent}`;
    if (key !== null && listed.has(key)) {
      childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), session]);
    } else {
      roots.push(session);
    }
  }

  const flattened: SessionTreeNode<S>[] = [];
  const visited = new Set<S>();
  function visit(session: S, depth: number): void {
    if (visited.has(session)) return;
    visited.add(session);
    flattened.push({ session, depth });
    for (const child of childrenByParent.get(`${session.agent}\0${sessionKey(session)}`) ?? []) visit(child, depth + 1);
  }
  for (const root of roots) visit(root, 0);
  // A parent cycle leaves sessions no root reaches; list them rather than drop them.
  for (const session of source) visit(session, 0);
  return flattened;
}
