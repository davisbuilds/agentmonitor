import { describe, expect, it } from 'vitest';
import { buildSessionTree, sessionKey } from './session-tree';

const UUID = '01a135ab-28ea-70f2-a603-35d75f361637';
const ROLLOUT = `rollout-2026-10-01T10-00-00-${UUID}`;

function session(id: string, agent: string, parent: string | null = null, integration_mode: string | null = null) {
  return { id, agent, parent_session_id: parent, integration_mode };
}

describe('sessionKey', () => {
  it('collapses a Codex rollout transcript and its telemetry row to one session', () => {
    expect(sessionKey(session(ROLLOUT, 'codex', null, 'codex-jsonl'))).toBe(UUID);
    expect(sessionKey(session(UUID.toUpperCase(), 'codex', null, 'codex-otel'))).toBe(UUID);
  });

  it('leaves other ids alone', () => {
    expect(sessionKey(session(ROLLOUT, 'codex', null, 'something-new'))).toBe(ROLLOUT);
    expect(sessionKey(session('agent-a1', 'claude', null, 'claude-jsonl'))).toBe('agent-a1');
    expect(sessionKey(session(UUID.toUpperCase(), 'claude'))).toBe(UUID.toUpperCase());
  });
});

describe('buildSessionTree', () => {
  it('nests subagents under a parent, including a Codex parent named by its UUID', () => {
    const tree = buildSessionTree([
      session('c-parent', 'claude'),
      session('agent-c1', 'claude', 'c-parent'),
      session(ROLLOUT, 'codex', null, 'codex-jsonl'),
      session('rollout-2026-10-01T10-05-00-01a13839-347a-79a2-b7b0-2359f2547f8a', 'codex', UUID.toUpperCase(), 'codex-jsonl'),
      session('agent-orphan', 'claude', 'missing'),
    ]);
    expect(tree.map(node => [node.session.id, node.depth])).toEqual([
      ['c-parent', 0],
      ['agent-c1', 1],
      [ROLLOUT, 0],
      ['rollout-2026-10-01T10-05-00-01a13839-347a-79a2-b7b0-2359f2547f8a', 1],
      ['agent-orphan', 0],
    ]);
  });

  it('does not nest across agents that share an id', () => {
    const tree = buildSessionTree([session('same', 'claude'), session('child', 'codex', 'same')]);
    expect(tree.map(node => node.depth)).toEqual([0, 0]);
  });
});
