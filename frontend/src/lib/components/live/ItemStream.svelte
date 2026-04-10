<script lang="ts">
  import type { LiveItem, LiveSession, LiveTurn } from '../../api/client';
  import { timeAgo } from '../../format';
  import ProjectionCapabilities from '../shared/ProjectionCapabilities.svelte';
  import { hasSessionCapability } from '../../session-capabilities';

  interface Props {
    session: LiveSession | null;
    turns: LiveTurn[];
    items: LiveItem[];
    selectedItemId: number | null;
    loading: boolean;
    error: string | null;
    hasMore: boolean;
    selectedKinds: string[];
    onselect: (itemId: number) => void;
    ontogglekind: (kind: string) => void;
    onloadmore: () => void;
    onopenhistory: () => void;
  }

  let {
    session,
    turns,
    items,
    selectedItemId,
    loading,
    error,
    hasMore,
    selectedKinds,
    onselect,
    ontogglekind,
    onloadmore,
    onopenhistory,
  }: Props = $props();

  const kindFilters = ['reasoning', 'tool_call', 'tool_result', 'plan', 'message'];

  function parsePayload(item: LiveItem): Record<string, unknown> | null {
    try {
      return JSON.parse(item.payload_json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  function findText(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      for (const item of value) {
        const next = findText(item);
        if (next) return next;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      for (const key of ['summary', 'text', 'thinking', 'content', 'result_content', 'title', 'label', 'name']) {
        const next = findText((value as Record<string, unknown>)[key]);
        if (next) return next;
      }
    }
    return null;
  }

  function summaryFor(item: LiveItem): string {
    const payload = parsePayload(item);
    if (!payload) return item.payload_json;

    if (item.kind === 'plan' && Array.isArray(payload.steps)) {
      return `${payload.steps.length} planned step${payload.steps.length === 1 ? '' : 's'}`;
    }

    if (item.kind === 'tool_call') {
      const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : findText(payload);
      return toolName ? `Call ${toolName}` : 'Tool call';
    }

    if (item.kind === 'tool_result') {
      const status = typeof payload.status === 'string' ? payload.status : item.status;
      const text = findText(payload);
      return status ? `${status}: ${text || 'result received'}` : (text || 'Tool result');
    }

    return findText(payload) || item.kind;
  }

  function preview(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 220);
  }

  function badgeClasses(kind: string): string {
    switch (kind) {
      case 'reasoning':
        return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
      case 'tool_call':
        return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
      case 'tool_result':
        return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
      case 'plan':
        return 'bg-violet-500/15 text-violet-300 border-violet-500/30';
      default:
        return 'bg-gray-700/40 text-gray-300 border-gray-700';
    }
  }

  function turnLabel(turnId: number | null): string | null {
    if (turnId == null) return null;
    const turn = turns.find(candidate => candidate.id === turnId);
    if (!turn) return `Turn ${turnId}`;
    return turn.title || turn.source_turn_id || `Turn ${turn.id}`;
  }
</script>

<div class="flex h-full flex-col overflow-hidden">
  <div class="border-b border-gray-800 px-4 py-3 shrink-0">
    {#if session}
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-base font-semibold text-gray-100 truncate">{session.project || session.id}</h2>
          <div class="mt-1 flex items-center gap-2 flex-wrap text-xs text-gray-500">
            <span class="rounded border border-gray-700 px-1.5 py-0.5 uppercase tracking-wide">{session.integration_mode || 'unknown source'}</span>
            <span class="rounded border border-gray-700 px-1.5 py-0.5 uppercase tracking-wide">{session.fidelity || 'n/a'} fidelity</span>
            <ProjectionCapabilities capabilities={session.capabilities} variant="summary" />
            <span class="rounded border border-gray-700 px-1.5 py-0.5 uppercase tracking-wide">{session.live_status || 'unknown'}</span>
            <span>{turns.length} turn{turns.length === 1 ? '' : 's'}</span>
            <span>{items.length} item{items.length === 1 ? '' : 's'}</span>
          </div>
          {#if !hasSessionCapability(session.capabilities, 'history')}
            <p class="mt-2 text-[11px] text-amber-300/90">
              Transcript history is not available for this source yet. Use the live stream as the primary view.
            </p>
          {/if}
        </div>
        <button class="shrink-0 text-sm text-blue-400 hover:text-blue-300" onclick={onopenhistory}>
          Open in Sessions
        </button>
      </div>
    {:else}
      <h2 class="text-base font-semibold text-gray-100">Live Stream</h2>
    {/if}

    <div class="mt-3 flex items-center gap-2 flex-wrap">
      {#each kindFilters as kind}
        <button
          class="rounded border px-2 py-1 text-xs uppercase tracking-wide transition-colors {selectedKinds.includes(kind) ? 'border-blue-500/50 bg-blue-500/10 text-blue-200' : 'border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200'}"
          onclick={() => ontogglekind(kind)}
        >
          {kind.replace('_', ' ')}
        </button>
      {/each}
    </div>
  </div>

  <div class="flex-1 overflow-y-auto px-4 py-4 space-y-3">
    {#if loading && items.length === 0}
      <div class="py-12 text-center text-sm text-gray-500">Loading live items...</div>
    {:else if error}
      <div class="py-12 text-center text-sm text-red-400">{error}</div>
    {:else if !session}
      <div class="py-12 text-center text-sm text-gray-500">Select a live session to inspect its stream.</div>
    {:else if items.length === 0}
      <div class="py-12 text-center text-sm text-gray-500">No live items for this session yet.</div>
    {:else}
      {#each items as item (item.id)}
        <button
          class="w-full text-left rounded-xl border px-3 py-3 transition-colors {selectedItemId === item.id ? 'border-blue-500/60 bg-blue-500/10' : 'border-gray-800 bg-gray-900/50 hover:border-gray-700 hover:bg-gray-900/80'}"
          onclick={() => onselect(item.id)}
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${badgeClasses(item.kind)}`}>
                  {item.kind.replace('_', ' ')}
                </span>
                {#if item.status}
                  <span class="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
                    {item.status}
                  </span>
                {/if}
                {#if turnLabel(item.turn_id)}
                  <span class="text-xs text-gray-500">{turnLabel(item.turn_id)}</span>
                {/if}
              </div>
              <p class="mt-2 text-sm text-gray-200">{preview(summaryFor(item))}</p>
            </div>
            <div class="shrink-0 text-right text-xs text-gray-500">
              <div>#{item.ordinal}</div>
              {#if item.created_at}
                <div class="mt-1">{timeAgo(item.created_at)}</div>
              {/if}
            </div>
          </div>
        </button>
      {/each}

      {#if hasMore}
        <div class="pt-2 text-center">
          <button class="text-sm text-blue-400 hover:text-blue-300" onclick={onloadmore}>
            Load newer items
          </button>
        </div>
      {/if}
    {/if}
  </div>
</div>
