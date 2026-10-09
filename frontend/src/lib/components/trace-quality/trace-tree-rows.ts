import type { TraceQualityObservationTreeNode } from '../../api/client';

/** One trace-tree row: an observation, plus the tool result folded into its call. */
export interface TraceTreeRow {
  node: TraceQualityObservationTreeNode;
  result: TraceQualityObservationTreeNode | null;
}

function isToolResult(node: TraceQualityObservationTreeNode): boolean {
  return node.name.startsWith('Tool result');
}

// Claude calls and results share the tool_use id; Codex ids them
// `<call_id>:decision` and `<call_id>:result`.
function callKey(node: TraceQualityObservationTreeNode): string | null {
  if (!node.source_item_id) return null;
  return node.source_item_id.replace(/:(decision|result)$/, '');
}

/**
 * Fold each tool result into the earlier sibling tool call it answers, so a call
 * and its outcome take one row. A result without a matching earlier call, or a
 * second result for the same call, keeps a row of its own.
 */
export function foldToolResults(nodes: readonly TraceQualityObservationTreeNode[]): TraceTreeRow[] {
  const rows: TraceTreeRow[] = [];
  const openCalls = new Map<string, TraceTreeRow>();
  for (const node of nodes) {
    const key = callKey(node);
    if (isToolResult(node) && key && node.children.length === 0) {
      const call = openCalls.get(key);
      if (call) {
        call.result = node;
        openCalls.delete(key);
        continue;
      }
    }
    const row: TraceTreeRow = { node, result: null };
    rows.push(row);
    if (node.observation_type === 'tool' && !isToolResult(node) && key) openCalls.set(key, row);
  }
  return rows;
}
