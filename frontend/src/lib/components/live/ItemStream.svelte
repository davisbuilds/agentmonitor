<script lang="ts">
  import type { LiveItem, LiveSession, LiveTurn } from '../../api/client';
  import { timeAgo } from '../../format';
  import ProjectionCapabilities from '../shared/ProjectionCapabilities.svelte';
  import { hasSessionCapability } from '../../session-capabilities';
  import { Badge, Button } from '../ui';
  import {
    buildLiveStreamRows,
    rowBody,
    rowFailed,
    rowLabel,
    toolArgument,
    type LiveStreamRow,
  } from '../../live-stream-rows';
  import { isNotableStatus } from '../../status';

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

  const kindFilters: Array<{ value: string; label: string }> = [
    { value: 'message', label: 'Messages' },
    { value: 'reasoning', label: 'Thinking' },
    { value: 'tool_call', label: 'Tool calls' },
    { value: 'tool_result', label: 'Tool results' },
    { value: 'plan', label: 'Plans' },
  ];

  const rows = $derived(buildLiveStreamRows(items));

  function preview(text: string, max = 220): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  // One dot per row in the design's signal tokens: you = accent, the assistant =
  // ok, tools neutral, a plan = warn, and anything that failed = danger.
  function dotClass(row: LiveStreamRow): string {
    if (rowFailed(row)) return 'bg-danger';
    switch (row.item.kind) {
      case 'user_message':
        return 'bg-accent';
      case 'assistant_message':
        return 'bg-ok';
      case 'plan_update':
        return 'bg-warn';
      default:
        return 'bg-text-faint';
    }
  }

  type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn';
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

</script>

<div class="flex flex-col xl:h-full xl:overflow-hidden">
  <div class="shrink-0 border-b border-line px-4 py-3">
    {#if session}
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="truncate text-h3">{session.project || session.id}</h2>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-meta text-text-faint">
            <span>{session.integration_mode || 'unknown source'} · {session.fidelity || 'n/a'} fidelity</span>
            <ProjectionCapabilities capabilities={session.capabilities} variant="summary" />
            <Badge tone={statusTone(session.live_status)}>{session.live_status || 'unknown'}</Badge>
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
      {#each kindFilters as kind (kind.value)}
        <button
          class="rounded-sm border px-2 py-1 text-meta transition-colors {selectedKinds.includes(kind.value) ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-text-muted hover:border-line-strong hover:text-text'}"
          aria-pressed={selectedKinds.includes(kind.value)}
          onclick={() => ontogglekind(kind.value)}
        >
          {kind.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="space-y-0.5 px-2 py-2 xl:flex-1 xl:overflow-y-auto">
    {#if loading && items.length === 0}
      <div class="py-12 text-center text-meta text-text-muted">Loading live items…</div>
    {:else if error}
      <div class="py-12 text-center text-meta text-danger">{error}</div>
    {:else if !session}
      <div class="py-12 text-center text-meta text-text-muted">Select a live session to inspect its stream.</div>
    {:else if items.length === 0}
      <div class="py-12 text-center text-meta text-text-muted">No live items for this session yet.</div>
    {:else}
      {#each rows as row (row.item.id)}
        {@const failed = rowFailed(row)}
        {@const argument = row.item.kind === 'tool_call' ? toolArgument(row.item) : null}
        {@const body = rowBody(row)}
        <button
          class="animate-row-enter w-full rounded-sm border px-3 py-2 text-left transition-colors {selectedItemId === row.item.id ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:border-line hover:bg-surface-2'}"
          onclick={() => onselect(row.item.id)}
        >
          <div class="flex items-center gap-2">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full {dotClass(row)}" aria-hidden="true"></span>
            <span class="shrink-0 text-meta {row.item.kind === 'tool_call' || row.item.kind === 'tool_result' ? 'font-mono text-text' : 'text-text-muted'}">{rowLabel(row.item)}</span>
            {#if argument}
              <span class="min-w-0 flex-1 truncate font-mono text-meta text-text-muted">{preview(argument, 160)}</span>
            {:else}
              <span class="flex-1"></span>
            {/if}
            {#if failed}
              <span class="shrink-0 text-meta text-danger">failed</span>
            {:else if isNotableStatus(row.item.status)}
              <span class="shrink-0 text-meta text-warn">{row.item.status}</span>
            {/if}
            {#if row.item.created_at}
              <span class="shrink-0 tabular font-mono text-meta text-text-faint">{timeAgo(row.item.created_at)}</span>
            {/if}
          </div>
          {#if body}
            <p class="mt-1 line-clamp-2 pl-3.5 text-meta {row.item.kind === 'user_message' || row.item.kind === 'assistant_message' ? 'text-text' : 'text-text-muted'} {failed ? 'text-danger' : ''}">{preview(body)}</p>
          {/if}
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
