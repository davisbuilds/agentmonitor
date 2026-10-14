<script lang="ts">
  import { onMount } from 'svelte';
  import { navigateToSession, setTab } from '../../stores/router.svelte';
  import { setSelectedSessionId } from '../../stores/monitor.svelte';
  import {
    followLiveSession,
    getLiveConnectionStatus,
    getLiveItems,
    getLiveItemsError,
    getLiveItemsHasMore,
    getLiveItemsLoading,
    getLiveSessionLoadFailed,
    getLiveSessionMissing,
    getLiveSettings,
    getLiveTurns,
    getSelectedLiveItem,
    getSelectedLiveItemId,
    getSelectedLiveKinds,
    getSelectedLiveSession,
    loadMoreLiveItems,
    setSelectedLiveItem,
    stopFollowingLiveSession,
    toggleLiveItemKind,
  } from '../../stores/live.svelte';
  import { connectLiveSSE, disconnectLiveSSE } from '../../stores/live-sse';
  import { pairedToolResult } from '../../live-stream-rows';
  import ItemStream from '../live/ItemStream.svelte';
  import InspectorPanel from '../live/InspectorPanel.svelte';
  import { Button, EmptyState, Popover, StatusDot } from '../ui';

  interface Props {
    sessionId: string;
  }
  let { sessionId }: Props = $props();

  const session = $derived(getSelectedLiveSession());
  const missing = $derived(getLiveSessionMissing());
  const loadFailed = $derived(getLiveSessionLoadFailed());
  const turns = $derived(getLiveTurns());
  const items = $derived(getLiveItems());
  const selectedItem = $derived(getSelectedLiveItem());
  const selectedResult = $derived(pairedToolResult(items, selectedItem));
  const connectionStatus = $derived(getLiveConnectionStatus());
  const liveSettings = $derived(getLiveSettings());
  const captureRows = $derived([
    { label: 'Prompts', on: liveSettings.capture.prompts },
    { label: 'Reasoning', on: liveSettings.capture.reasoning },
    { label: 'Tool arguments', on: liveSettings.capture.tool_arguments },
  ]);
  const captureAllOn = $derived(captureRows.every(row => row.on));

  $effect(() => {
    void followLiveSession(sessionId);
  });

  onMount(() => {
    connectLiveSSE();
    return () => {
      disconnectLiveSSE();
      stopFollowingLiveSession();
    };
  });
</script>

<div class="flex flex-col gap-3 xl:min-h-0 xl:flex-1">
  <div class="flex shrink-0 items-center justify-between gap-3">
    <Button variant="ghost" size="sm" onclick={() => setTab('monitor')}>← Active agents</Button>
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
  </div>

  {#if missing}
    <section class="rounded-lg border border-line bg-surface">
      <EmptyState
        title="No live stream for this session."
        description="Its events reached the Monitor, but nothing was recorded for the live view."
      >
        {#snippet action()}
          <Button variant="neutral" size="sm" onclick={() => setSelectedSessionId(sessionId)}>Show recent events</Button>
        {/snippet}
      </EmptyState>
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
          hasMore={getLiveItemsHasMore()}
          selectedKinds={getSelectedLiveKinds()}
          onselect={setSelectedLiveItem}
          ontogglekind={toggleLiveItemKind}
          onloadmore={() => void loadMoreLiveItems()}
          onopenhistory={() => navigateToSession(sessionId)}
        />
      </section>

      <section class="min-h-[20rem] rounded-lg border border-line bg-surface xl:min-h-0 xl:w-[22rem] xl:shrink-0 xl:overflow-hidden">
        <InspectorPanel {session} {turns} item={selectedItem} result={selectedResult} />
      </section>
    </div>
  {/if}
</div>
