<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { LiveItem, LiveSession, LiveTurn } from '../../api/client';
  import { formatDuration, formatNumber, timeAgo } from '../../format';
  import SessionCoverage from '../shared/SessionCoverage.svelte';
  import { sessionTitle } from '../../session-text';
  import { hasSessionCapability } from '../../session-capabilities';
  import { Button, StatusDot } from '../ui';
  import {
    buildLiveStreamRows,
    rowBody,
    rowFailed,
    rowDurationMs,
    rowLabel,
    toolArgument,
    type LiveStreamRow,
  } from '../../live-stream-rows';
  import { isNotableStatus, liveDotStatus } from '../../status';

  interface Props {
    session: LiveSession | null;
    turns: LiveTurn[];
    items: LiveItem[];
    selectedItemId: number | null;
    loading: boolean;
    error: string | null;
    hasEarlier: boolean;
    /** Every item the session has, whatever the kind filter. */
    total: number;
    selectedKinds: string[];
    onselect: (itemId: number) => void;
    ontogglekind: (kind: string) => void;
    onloadearlier: () => Promise<void>;
    onopenhistory: () => void;
  }

  let {
    session,
    turns,
    items,
    selectedItemId,
    loading,
    error,
    hasEarlier,
    total,
    selectedKinds,
    onselect,
    ontogglekind,
    onloadearlier,
    onopenhistory,
  }: Props = $props();

  // Each value is the stored item kinds it selects, comma-joined as the API takes them.
  const kindFilters: Array<{ value: string; label: string }> = [
    { value: 'user_message,assistant_message', label: 'Messages' },
    { value: 'reasoning', label: 'Thinking' },
    { value: 'tool_call', label: 'Tool calls' },
    { value: 'tool_result', label: 'Tool results' },
    { value: 'instructions', label: 'Instructions' },
    { value: 'plan_update', label: 'Plans' },
  ];

  // The newest item is at the top. New ones appear there while you are at the
  // top; scrolled further down, the rows you are reading stay put as they
  // arrive above. Scrolling to the bottom loads the page before.
  let scroller = $state<HTMLDivElement>();
  let atTop = true;
  const NEAR_EDGE_PX = 48;

  async function loadEarlier(): Promise<void> {
    if (!hasEarlier || loading) return;
    // Older items go below the rows shown, so nothing on screen moves.
    await onloadearlier();
  }

  function handleScroll(): void {
    if (!scroller) return;
    atTop = scroller.scrollTop < NEAR_EDGE_PX;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_EDGE_PX) void loadEarlier();
  }

  function backToTop(): void {
    atTop = true;
    if (scroller) scroller.scrollTop = 0;
  }

  // A new session or kind filter reopens the stream at its newest item.
  const sessionId = $derived(session?.id ?? null);
  $effect(() => {
    void sessionId;
    untrack(backToTop);
  });

  function toggleKind(kind: string): void {
    backToTop();
    ontogglekind(kind);
  }

  // Before newer items render above you, note where you are, then shift by
  // what they added. (Browser scroll anchoring is off on the scroller so the
  // two never both apply; Safari has none.)
  let newestShownId: number | null = null;
  $effect.pre(() => {
    const newest = items.length > 0 ? items[items.length - 1].id : null;
    const previous = newestShownId;
    newestShownId = newest;
    const el = untrack(() => scroller);
    if (!el || atTop || previous === null || newest === null || newest === previous) return;
    const heightBefore = el.scrollHeight;
    const topBefore = el.scrollTop;
    void tick().then(() => {
      el.scrollTop = topBefore + (el.scrollHeight - heightBefore);
    });
  });

  const rows = $derived(buildLiveStreamRows(items).reverse());

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


</script>

<div class="flex flex-col xl:h-full xl:overflow-hidden">
  <div class="shrink-0 border-b border-line px-4 py-3">
    {#if session}
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="truncate text-h3">{sessionTitle(session)}</h2>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-meta text-text-faint">
            {#if session.project}<span>{session.project}</span>{/if}
            <StatusDot status={liveDotStatus(session.live_status)} label={session.live_status || 'unknown'} />
            <SessionCoverage
              capabilities={session.capabilities}
              integrationMode={session.integration_mode}
              fidelity={session.fidelity}
            />
            <span class="tabular font-mono">{turns.length} turn{turns.length === 1 ? '' : 's'}</span>
            <!-- The stream holds the newest page or so; say how much of the session that is. -->
            <span class="tabular font-mono">
              {#if hasEarlier && selectedKinds.length === 0}
                {formatNumber(items.length)} of {formatNumber(total)} items
              {:else}
                {items.length} item{items.length === 1 ? '' : 's'}
              {/if}
            </span>
          </div>
          {#if !hasSessionCapability(session.capabilities, 'history')}
            <p class="mt-2 text-meta text-warn">
              No transcript was recorded for this session; the live stream below is all there is.
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
          onclick={() => toggleKind(kind.value)}
        >
          {kind.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="space-y-0.5 px-2 py-2 [overflow-anchor:none] xl:flex-1 xl:overflow-y-auto" bind:this={scroller} onscroll={handleScroll} data-testid="live-stream-scroller">
    {#if loading && items.length === 0}
      <div class="py-12 text-center text-meta text-text-muted">Loading live items…</div>
    {:else if error}
      <div class="py-12 text-center text-meta text-danger">{error}</div>
    {:else if !session}
      <div class="py-12 text-center text-meta text-text-muted">Loading session…</div>
    {:else if items.length === 0}
      <div class="py-12 text-center text-meta text-text-muted">No live items for this session yet.</div>
    {:else}
      {#each rows as row (row.item.id)}
        {@const failed = rowFailed(row)}
        {@const durationMs = rowDurationMs(row)}
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
            {#if durationMs != null}
              <span class="shrink-0 tabular font-mono text-meta text-text-faint" title="Took">{formatDuration(durationMs)}</span>
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
      {#if hasEarlier}
        <div class="pt-2 text-center">
          <Button variant="ghost" size="sm" disabled={loading} onclick={() => void loadEarlier()}>Load older items</Button>
        </div>
      {/if}
    {/if}
  </div>
</div>
