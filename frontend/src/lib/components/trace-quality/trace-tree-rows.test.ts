import { describe, it, expect } from 'vitest';
import type { TraceQualityObservationTreeNode } from '../../api/client';
import { foldToolResults } from './trace-tree-rows';

let nextId = 1;
function node(name: string, sourceItemId: string | null, extra: Partial<TraceQualityObservationTreeNode> = {}): TraceQualityObservationTreeNode {
  const id = `obs-${nextId++}`;
  return {
    id,
    trace_id: 't',
    parent_observation_id: null,
    session_id: 's',
    source_kind: 'session_item',
    source_id: null,
    source_item_id: sourceItemId,
    observation_type: name.startsWith('Tool') ? 'tool' : 'event',
    name,
    status: 'success',
    status_message: null,
    severity: 'info',
    model: null,
    tool_name: null,
    started_at: null,
    ended_at: null,
    duration_ms: null,
    tokens_in: 0,
    tokens_out: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: null,
    input_hash: null,
    output_hash: null,
    input_summary: null,
    output_summary: null,
    payload_policy: 'summary',
    metadata: {},
    created_at: '2026-10-09T00:00:00Z',
    children: [],
    ...extra,
  };
}

const shape = (nodes: TraceQualityObservationTreeNode[]) => foldToolResults(nodes).map(row => [row.node.id, row.result?.id ?? null]);

describe('foldToolResults', () => {
  it('folds a Claude result into the call that shares its tool_use id', () => {
    const user = node('User message', 'claude-message:0:item:0');
    const call = node('Tool: Bash', 'toolu_1');
    const result = node('Tool result', 'toolu_1');
    expect(shape([user, call, result])).toEqual([[user.id, null], [call.id, result.id]]);
  });

  it('folds a Codex result into its decision through the shared call id', () => {
    const call = node('Tool: exec_command', 'exec-1:decision');
    const result = node('Tool result', 'exec-1:result');
    expect(shape([call, result])).toEqual([[call.id, result.id]]);
  });

  it('pairs interleaved calls with their own results', () => {
    const a = node('Tool: Read', 'toolu_a');
    const b = node('Tool: Grep', 'toolu_b');
    const resultB = node('Tool result', 'toolu_b');
    const resultA = node('Tool result', 'toolu_a');
    expect(shape([a, b, resultB, resultA])).toEqual([[a.id, resultA.id], [b.id, resultB.id]]);
  });

  it('keeps an unmatched, a repeated, or an id-less result as its own row', () => {
    const orphan = node('Tool result', 'toolu_gone');
    const call = node('Tool: Bash', 'toolu_2');
    const first = node('Tool result', 'toolu_2');
    const second = node('Tool result', 'toolu_2');
    const anonymous = node('Tool result', null);
    expect(shape([orphan, call, first, second, anonymous])).toEqual([
      [orphan.id, null], [call.id, first.id], [second.id, null], [anonymous.id, null],
    ]);
  });

  it('does not fold a result that has children of its own', () => {
    const call = node('Tool: Task', 'toolu_3');
    const result = node('Tool result', 'toolu_3', { children: [node('User message', 'x')] });
    expect(shape([call, result])).toEqual([[call.id, null], [result.id, null]]);
  });

  it('returns no rows for no nodes', () => {
    expect(foldToolResults([])).toEqual([]);
  });
});
