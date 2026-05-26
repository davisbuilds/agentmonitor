<script lang="ts">
  import type { LiveItem, LiveSession, LiveTurn } from '../../api/client';
  import { timeAgo } from '../../format';
  import ProjectionCapabilities from '../shared/ProjectionCapabilities.svelte';
  import { hasSessionCapability } from '../../session-capabilities';
  import { Badge, Button } from '../ui';

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

  // Item kinds map onto the design's signal tokens (no bespoke hues): tool_call =
  // the agent acting (accent), tool_result = a result (ok), plan = warn, the rest neutral.
  type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn';
  function kindTone(kind: string): BadgeTone {
    switch (kind) {
      case 'tool_call':
        return 'accent';
      case 'tool_result':
        return 'ok';
      case 'plan':
        return 'warn';
      default:
        return 'neutral';
    }
  }

  function statusTone(status: string | null): BadgeTone {
    switch (status) {
      case 'live':
      case 'active':
        return 'ok';
      case 'idle':
        return 'warn';
      default:
        return 'neutral';
    }
  }

  function turnLabel(turnId: number | null): string | null {
    if (turnId == null) return null;
    const turn = turns.find(candidate => candidate.id === turnId);
    if (!turn) return `Turn ${turnId}`;
    return turn.title || turn.source_turn_id || `Turn ${turn.id}`;
  }
</script>

<div class="flex flex-col xl:h-full xl:overflow-hidden">
  <div class="shrink-0 border-b border-line px-4 py-3">
    {#if session}
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="truncate text-h3">{session.project || session.id}</h2>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-meta text-text-faint">
            <Badge tone="neutral" class="uppercase tracking-wide">{session.integration_mode || 'unknown source'}</Badge>
            <Badge tone="neutral" class="uppercase tracking-wide">{session.fidelity || 'n/a'} fidelity</Badge>
            <ProjectionCapabilities capabilities={session.capabilities} variant="summary" />
            <Badge tone={statusTone(session.live_status)} class="uppercase tracking-wide">{session.live_status || 'unknown'}</Badge>
            <span class="tabular font-mono">{turns.length} turn{turns.length === 1 ? '' : 's'}</span>
            <span class="tabular font-mono">{items.length} item{items.length === 1 ? '' : 's'}</span>
          </div>
          {#if !hasSessionCapability(session.capabilities, 'history')}
            <p class="mt-2 text-meta text-warn">
              Transcript history is not available for this source yet. Use the live stream as the primary view.
            </p>
          {/if}
        </div>
        <Button variant="ghost" size="sm" onclick={onopenhistory}>Open in Sessions</Button>
      </div>
    {:else}
      <h2 class="text-h3">Live Stream</h2>
    {/if}

    <div class="mt-3 flex flex-wrap items-center gap-2">
      {#each kindFilters as kind}
        <button
          class="rounded-sm border px-2 py-1 text-meta uppercase tracking-wide transition-colors {selectedKinds.includes(kind) ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-text-muted hover:border-line-strong hover:text-text'}"
          onclick={() => ontogglekind(kind)}
        >
          {kind.replace('_', ' ')}
        </button>
      {/each}
    </div>
  </div>

  <div class="space-y-2 px-4 py-4 xl:flex-1 xl:overflow-y-auto">
    {#if loading && items.length === 0}
      <div class="py-12 text-center text-meta text-text-muted">Loading live items…</div>
    {:else if error}
      <div class="py-12 text-center text-meta text-danger">{error}</div>
    {:else if !session}
      <div class="py-12 text-center text-meta text-text-muted">Select a live session to inspect its stream.</div>
    {:else if items.length === 0}
      <div class="py-12 text-center text-meta text-text-muted">No live items for this session yet.</div>
    {:else}
      {#each items as item (item.id)}
        <button
          class="animate-row-enter w-full rounded-sm border px-3 py-3 text-left transition-colors {selectedItemId === item.id ? 'border-accent/50 bg-accent/10' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2'}"
          onclick={() => onselect(item.id)}
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <Badge tone={kindTone(item.kind)} class="uppercase tracking-wide">{item.kind.replace('_', ' ')}</Badge>
                {#if item.status}
                  <Badge tone="neutral" class="uppercase tracking-wide">{item.status}</Badge>
                {/if}
                {#if turnLabel(item.turn_id)}
                  <span class="text-meta text-text-faint">{turnLabel(item.turn_id)}</span>
                {/if}
              </div>
              <p class="mt-2 text-body text-text">{preview(summaryFor(item))}</p>
            </div>
            <div class="shrink-0 text-right tabular font-mono text-meta text-text-faint">
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
          <Button variant="ghost" size="sm" onclick={onloadmore}>Load newer items</Button>
        </div>
      {/if}
    {/if}
  </div>
</div>
