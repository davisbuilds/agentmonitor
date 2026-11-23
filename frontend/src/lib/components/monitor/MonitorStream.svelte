<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { navigateToSession, setTab } from '../../stores/router.svelte';
  import {
    getAutoImportSignal,
    getEvents,
    getReconnectSignal,
    getSessionOccupancy,
    getSessions,
  } from '../../stores/monitor.svelte';
  import {
    followLiveSession,
    getLiveConnectionStatus,
    getLiveItems,
    getLiveItemsError,
    getLiveItemsHasEarlier,
    getLiveItemsTotal,
    getLiveItemsLoading,
    getLiveSessionLoadFailed,
    getLiveSessionMissing,
    getLiveSettings,
    getLiveTurns,
    getSelectedLiveItem,
    getSelectedLiveItemId,
    getSelectedLiveKinds,
    getSelectedLiveSession,
    loadEarlierLiveItems,
    setSelectedLiveItem,
    stopFollowingLiveSession,
    toggleLiveItemKind,
  } from '../../stores/live.svelte';
  import { connectLiveSSE, disconnectLiveSSE } from '../../stores/live-sse';
  import { ApiError, fetchSessionDetail, type AgentEvent, type Session } from '../../api/client';
  import { pairedToolResult } from '../../live-stream-rows';
  import { buildActiveAgentLabel } from '../../monitor-analytics';
  import { SESSION_EVENT_LIMIT, followedSessionSummary, sessionRecentEvents } from '../../monitor-session-view';
  import ItemStream from '../live/ItemStream.svelte';
  import InspectorPanel from '../live/InspectorPanel.svelte';
  import SessionEvents from './SessionEvents.svelte';
  import SessionSummary from './SessionSummary.svelte';
  import { Button, EmptyState, Popover, StatusDot } from '../ui';

  interface Props {
    sessionId: string;
  }
  let { sessionId }: Props = $props();

  const liveSettings = $derived(getLiveSettings());
  const liveEnabled = $derived(liveSettings.enabled);
  const session = $derived(getSelectedLiveSession());
  const missing = $derived(getLiveSessionMissing());
  const loadFailed = $derived(getLiveSessionLoadFailed());
  const turns = $derived(getLiveTurns());
  const items = $derived(getLiveItems());
  const selectedItem = $derived(getSelectedLiveItem());
  const selectedResult = $derived(pairedToolResult(items, selectedItem));
  const connectionStatus = $derived(getLiveConnectionStatus());
  const captureRows = $derived([
    { label: 'Prompts', on: liveSettings.capture.prompts },
    { label: 'Reasoning', on: liveSettings.capture.reasoning },
    { label: 'Tool arguments', on: liveSettings.capture.tool_arguments },
  ]);
  const captureAllOn = $derived(captureRows.every(row => row.on));

  let inspectorView = $state<'details' | 'events'>('details');
  function selectItem(id: number): void {
    setSelectedLiveItem(id);
    inspectorView = 'details';
  }

  // WHY: Fetch Monitor details separately because the live stream does not carry the figures or recent
  // events used by the cards.
  let detailSession = $state<Session | null>(null);
  let detailEvents = $state<AgentEvent[]>([]);
  let detailLoading = $state(false);
  let detailError = $state<string | null>(null);
  let detailRequest = 0;

  async function loadDetail(id: string): Promise<void> {
    const request = ++detailRequest;
    detailLoading = true;
    try {
      const detail = await fetchSessionDetail(id, SESSION_EVENT_LIMIT);
      if (request !== detailRequest) return;
      detailSession = detail.session;
      detailEvents = detail.events;
      detailError = null;
    } catch (err) {
      if (request !== detailRequest) return;
      // WHY: A live-only session can have no Monitor record. Treat that absence as an empty event list.
      if (err instanceof ApiError && err.status === 404) {
        detailSession = null;
        detailEvents = [];
        detailError = null;
      } else {
        console.error('Failed to load session events:', err);
        detailError = "Couldn't load this session's events.";
      }
    } finally {
      if (request === detailRequest) detailLoading = false;
    }
  }

  // WHY: Hold this session’s events separately so other sessions cannot evict them from the globally
  // capped feed.
  let heldLiveEvents = $state<AgentEvent[]>([]);
  $effect(() => {
    const id = sessionId;
    const live = getEvents();
    untrack(() => {
      heldLiveEvents = sessionRecentEvents(id, heldLiveEvents, live);
    });
  });

  $effect(() => {
    const id = sessionId;
    detailSession = null;
    detailEvents = [];
    detailError = null;
    inspectorView = 'details';
    untrack(() => void loadDetail(id));
  });

  // WHY: Import completion and reconnect need explicit reads because their events may never arrive
  // through the live stream.
  let lastAutoImportSignal = getAutoImportSignal();
  let lastReconnectSignal = getReconnectSignal();
  $effect(() => {
    const autoImport = getAutoImportSignal();
    const reconnect = getReconnectSignal();
    if (autoImport === lastAutoImportSignal && reconnect === lastReconnectSignal) return;
    lastAutoImportSignal = autoImport;
    lastReconnectSignal = reconnect;
    const id = untrack(() => sessionId);
    untrack(() => void loadDetail(id));
  });

  const cardRow = $derived(getSessions().find(row => row.id === sessionId) ?? null);
  const summary = $derived(followedSessionSummary(cardRow, detailSession));
  const recentEvents = $derived(sessionRecentEvents(sessionId, detailEvents, heldLiveEvents));
  const agentLabel = $derived(summary ? buildActiveAgentLabel(summary.agent_type, recentEvents) : '');
  const eventsOnly = $derived(!liveEnabled || missing);

  // WHY: Keep the follow effect tied to the session and view mode so the store’s filter reads cannot
  // start a duplicate follow.
  $effect(() => {
    const id = sessionId;
    const live = liveEnabled;
    untrack(() => {
      if (live) void followLiveSession(id);
      else stopFollowingLiveSession();
    });
  });

  onMount(() => {
    connectLiveSSE();
    return () => {
      disconnectLiveSSE();
      stopFollowingLiveSession();
    };
  });
</script>

{#snippet eventsList()}
  <SessionEvents events={recentEvents} loading={detailLoading} error={detailError} />
{/snippet}

<div class="flex flex-col gap-3 xl:min-h-0 xl:flex-1">
  <div class="flex shrink-0 items-center justify-between gap-3">
    <Button variant="ghost" size="sm" onclick={() => setTab('monitor')}>← Active agents</Button>
    {#if liveEnabled}
      <div class="flex items-center gap-3">
        <StatusDot status={connectionStatus} label={connectionStatus} />
        <Popover align="right" width="w-64" label="Capture settings">
          {#snippet trigger({ toggle, open })}
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-meta text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
              aria-haspopup="dialog"
              aria-expanded={open}
              onclick={toggle}
            >
              <span class="h-1.5 w-1.5 rounded-full {captureAllOn ? 'bg-ok' : 'bg-warn'}" aria-hidden="true"></span>
              Capture {captureAllOn ? 'on' : 'limited'}
            </button>
          {/snippet}
          <ul class="space-y-1.5 text-meta">
            {#each captureRows as row (row.label)}
              <li class="flex items-center justify-between gap-3">
                <span class="text-text-muted">{row.label}</span>
                <span class="inline-flex items-center gap-1.5 text-text">
                  <span class="h-1.5 w-1.5 rounded-full {row.on ? 'bg-ok' : 'bg-line-strong'}" aria-hidden="true"></span>
                  {row.on ? 'on' : 'off'}
                </span>
              </li>
            {/each}
          </ul>
          <div class="mt-3 space-y-1 border-t border-line pt-2 text-meta text-text-faint">
            <div>Codex: <span class="text-text-muted">{liveSettings.codex_mode}</span></div>
            <div>Diffs kept up to <span class="tabular font-mono text-text-muted">{liveSettings.diff_payload_max_bytes.toLocaleString()}</span> bytes</div>
          </div>
        </Popover>
      </div>
    {/if}
  </div>

  {#if summary}
    <SessionSummary
      session={summary}
      label={agentLabel}
      occupancy={eventsOnly ? getSessionOccupancy(sessionId) : null}
    />
  {/if}

  {#if eventsOnly}
    <section class="rounded-lg border border-line bg-surface xl:min-h-0 xl:flex-1 xl:overflow-hidden">
      <div class="flex flex-col xl:h-full">
        <div class="shrink-0 border-b border-line px-4 py-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-h3">Recent events</h2>
              <p class="mt-1 text-meta text-text-faint">
                {#if liveEnabled}
                  No live stream for this session. Its events reached the Monitor, but nothing was recorded for the live view.
                {:else}
                  The live view is off, so this shows the events the Monitor received.
                {/if}
              </p>
            </div>
            <Button variant="ghost" size="sm" onclick={() => navigateToSession(sessionId)}>Open in Sessions</Button>
          </div>
        </div>
        <div class="px-2 py-2 xl:flex-1 xl:overflow-y-auto">
          {@render eventsList()}
        </div>
      </div>
    </section>
  {:else if loadFailed}
    <section class="rounded-lg border border-line bg-surface">
      <EmptyState
        title="Couldn't load this session."
        description="The live view didn't answer. Its stream may still be there."
      >
        {#snippet action()}
          <Button variant="neutral" size="sm" onclick={() => void followLiveSession(sessionId)}>Retry</Button>
        {/snippet}
      </EmptyState>
    </section>
  {:else}
    <div class="flex flex-col gap-4 xl:min-h-0 xl:flex-1 xl:flex-row">
      <section class="min-h-[24rem] rounded-lg border border-line bg-surface xl:min-h-0 xl:min-w-0 xl:flex-1 xl:overflow-hidden">
        <ItemStream
          {session}
          {turns}
          {items}
          selectedItemId={getSelectedLiveItemId()}
          loading={getLiveItemsLoading()}
          error={getLiveItemsError()}
          hasEarlier={getLiveItemsHasEarlier()}
          total={getLiveItemsTotal()}
          selectedKinds={getSelectedLiveKinds()}
          onselect={selectItem}
          ontogglekind={toggleLiveItemKind}
          onloadearlier={() => loadEarlierLiveItems()}
          onopenhistory={() => navigateToSession(sessionId)}
        />
      </section>
      <section class="min-h-[20rem] rounded-lg border border-line bg-surface xl:min-h-0 xl:w-[22rem] xl:shrink-0 xl:overflow-hidden">
        <InspectorPanel {session} {turns} item={selectedItem} result={selectedResult} events={eventsList} bind:view={inspectorView} />
      </section>
    </div>
  {/if}
</div>
