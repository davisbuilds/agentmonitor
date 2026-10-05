/** Milliseconds encoded in a UUIDv7's leading 48 bits, or null for anything else. */
function uuidV7Millis(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(value);
  return match ? parseInt(match[1] + match[2], 16) : null;
}

export type SubagentBoundary =
  | { kind: 'none' }
  | { kind: 'resolved'; line: number }
  | { kind: 'unresolved' };

/**
 * Where a `thread_spawn` subagent's own activity starts in its rollout.
 *
 * Codex can open a subagent rollout with a copy of the parent's history, token
 * counters included, re-stamped with the spawn time, so timestamps cannot mark
 * where the copy ends. Turn ids are UUIDv7: the child's own first turn is the
 * first `turn_context` issued at or after the rollout's own session id. A
 * subagent without such a turn is `unresolved`, and callers keep the whole
 * rollout rather than guess.
 */
export function findSubagentBoundary(
  lines: ReadonlyArray<{ type?: string; payload?: Record<string, unknown> } | null>,
): SubagentBoundary {
  const meta = lines.find(line => line?.type === 'session_meta')?.payload;
  const source = meta?.['source'] as Record<string, unknown> | undefined;
  const subagent = source && typeof source === 'object' ? source['subagent'] as Record<string, unknown> | undefined : undefined;
  if (!subagent || typeof subagent !== 'object' || !('thread_spawn' in subagent)) return { kind: 'none' };
  const spawnedAt = uuidV7Millis(meta?.['id']);
  if (spawnedAt === null) return { kind: 'unresolved' };
  const line = lines.findIndex(entry => {
    if (entry?.type !== 'turn_context') return false;
    const issuedAt = uuidV7Millis(entry.payload?.['turn_id']);
    return issuedAt !== null && issuedAt >= spawnedAt;
  });
  return line < 0 ? { kind: 'unresolved' } : { kind: 'resolved', line };
}
