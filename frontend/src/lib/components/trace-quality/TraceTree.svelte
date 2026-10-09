<script lang="ts">
  import { Badge } from '../ui';
  import type { TraceQualityObservationTreeNode } from '../../api/client';
  import { isNotableStatus } from '../../status';
  import { foldToolResults, type TraceTreeRow } from './trace-tree-rows';

  interface Props {
    nodes: TraceQualityObservationTreeNode[];
    selectedId: string | null;
    onselect: (id: string) => void;
  }

  let { nodes, selectedId, onselect }: Props = $props();

  // Default expanded; track collapsed ids so deep trees can be folded.
  let collapsed = $state<Record<string, boolean>>({});

  function toggle(id: string): void {
    collapsed = { ...collapsed, [id]: !collapsed[id] };
  }

  const TYPE_GLYPH: Record<string, string> = {
    generation: '◆', agent: '✦', tool: '⚙', chain: '⛓', retriever: '⛏',
    embedding: '⋯', evaluator: '✓', guardrail: '⛨', span: '▸', event: '•',
  };

  function statusTone(obs: TraceQualityObservationTreeNode): 'ok' | 'warn' | 'danger' | 'neutral' {
    if (obs.severity === 'critical' || obs.status === 'error') return 'danger';
    if (obs.severity === 'error' || obs.status === 'timeout') return 'warn';
    if (obs.status === 'success') return 'ok';
    return 'neutral';
  }

  // Success is the routine case; only a status or severity that says something
  // gets a badge.
  function showsStatus(obs: TraceQualityObservationTreeNode): boolean {
    if (obs.status) return isNotableStatus(obs.status);
    return obs.severity === 'warning' || obs.severity === 'error' || obs.severity === 'critical';
  }

  function formatDuration(ms: number | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  }

  function formatTokens(obs: TraceQualityObservationTreeNode): string | null {
    const total = obs.tokens_in + obs.tokens_out;
    return total > 0 ? new Intl.NumberFormat('en-US').format(total) : null;
  }

  function formatCost(value: number | null): string | null {
    if (value == null || value === 0) return null;
    return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
  }
</script>

{#snippet row(entry: TraceTreeRow, depth: number)}
  {@const obs = entry.node}
  {@const result = entry.result}
  {@const flagged = result && showsStatus(result) ? result : showsStatus(obs) ? obs : null}
  {@const hasChildren = obs.children.length > 0}
  {@const isCollapsed = collapsed[obs.id] === true}
  <div class="border-b border-line/40 last:border-b-0">
    <div
      role="button"
      tabindex="0"
      class={`flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-surface-2 ${selectedId === obs.id || (result && selectedId === result.id) ? 'bg-surface-2' : ''}`}
      style={`padding-left: ${depth * 1.1 + 0.5}rem`}
      onclick={() => onselect(obs.id)}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onselect(obs.id); } }}
    >
      {#if hasChildren}
        <span
          role="button"
          tabindex="-1"
          class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-text-faint hover:text-text"
          onclick={(e) => { e.stopPropagation(); toggle(obs.id); }}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(obs.id); } }}
          aria-label={isCollapsed ? 'Expand' : 'Collapse'}
        >{isCollapsed ? '▸' : '▾'}</span>
      {:else}
        <span class="inline-block h-4 w-4 shrink-0" aria-hidden="true"></span>
      {/if}

      <span class="shrink-0 text-text-faint" title={obs.observation_type}>{TYPE_GLYPH[obs.observation_type] ?? '•'}</span>
      <span class="min-w-0 flex-1 truncate text-meta text-text">{obs.name}</span>

      <span class="hidden shrink-0 items-center gap-2 font-mono text-meta text-text-faint sm:flex">
        {#if obs.model}<span class="truncate max-w-[10rem]" title={obs.model}>{obs.model}</span>{/if}
        {#if formatTokens(obs)}<span title="tokens">{formatTokens(obs)}t</span>{/if}
        {#if formatCost(obs.cost_usd)}<span title="cost">{formatCost(obs.cost_usd)}</span>{/if}
        {#if obs.duration_ms}<span title="duration" class="w-12 text-right">{formatDuration(obs.duration_ms)}</span>{/if}
      </span>

      {#if result}
        <button
          type="button"
          class={`shrink-0 rounded-sm px-1 text-meta transition-colors hover:text-text ${selectedId === result.id ? 'text-accent' : 'text-text-faint'}`}
          title="Inspect the tool result"
          onclick={(e) => { e.stopPropagation(); onselect(result.id); }}
        >result</button>
      {/if}

      {#if flagged}
        <Badge tone={statusTone(flagged)}>{flagged.status ?? flagged.severity}</Badge>
      {/if}
    </div>

    {#if hasChildren && !isCollapsed}
      {#each foldToolResults(obs.children) as child (child.node.id)}
        {@render row(child, depth + 1)}
      {/each}
    {/if}
  </div>
{/snippet}

<div class="overflow-hidden">
  {#each foldToolResults(nodes) as entry (entry.node.id)}
    {@render row(entry, 0)}
  {/each}
</div>
