import type { TraceQualityObservationTreeNode } from '../../api/client';

/**
 * One trace-tree row: an observation, the tool result folded into its call, and
 * the children still to show beneath it.
 */
export interface TraceTreeRow {
  node: TraceQualityObservationTreeNode;
  result: TraceQualityObservationTreeNode | null;
  children: TraceQualityObservationTreeNode[];
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
 * Fold each tool result into the tool call it answers, so a call and its
 * outcome take one row. The projection links a result to its call only when
 * both sit in the same turn, so a result may be the call's child or a later
 * sibling; both fold. A result without a matching call, or a second result for
 * the same call, keeps a row of its own.
 */
export function foldToolResults(nodes: readonly TraceQualityObservationTreeNode[]): TraceTreeRow[] {
  const rows: TraceTreeRow[] = [];
  const openCalls = new Map<string, TraceTreeRow>();
  const foldable = (node: TraceQualityObservationTreeNode, key: string | null): boolean =>
    isToolResult(node) && key !== null && callKey(node) === key && node.children.length === 0;
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
    const isCall = node.observation_type === 'tool' && !isToolResult(node) && key !== null;
    const nested = isCall ? node.children.find(child => foldable(child, key)) ?? null : null;
    const row: TraceTreeRow = {
      node,
      result: nested,
      children: nested ? node.children.filter(child => child !== nested) : node.children,
    };
    rows.push(row);
    if (isCall && !nested) openCalls.set(key, row);
  }
  return rows;
}
