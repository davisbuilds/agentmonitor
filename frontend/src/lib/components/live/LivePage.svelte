<script lang="ts">
  import { onMount } from 'svelte';
  import { buildSessionTree } from '../../session-tree';
  import { navigateToSession } from '../../stores/router.svelte';
  import {
    getLiveAgents,
    getLiveConnectionStatus,
    getLiveItems,
    getLiveItemsError,
    getLiveItemsHasMore,
    getLiveItemsLoading,
    getLiveProjects,
    getLiveSessions,
    getLiveSessionsError,
    getLiveSessionsHasMore,
    getLiveSessionsLoading,
    getLiveSettings,
    getLiveSessionsTotal,
    getLiveTurns,
    getSelectedLiveItem,
    getSelectedLiveItemId,
    getSelectedLiveKinds,
    getSelectedLiveSession,
    getSelectedLiveSessionId,
    initializeLivePage,
    loadLiveSessions,
    loadMoreLiveItems,
    loadMoreLiveSessions,
    resetLiveState,
    selectLiveSession,
    setLiveFilters,
    setSelectedLiveItem,
    toggleLiveItemKind,
  } from '../../stores/live.svelte';
  import { connectLiveSSE, disconnectLiveSSE } from '../../stores/live-sse';
  import { pairedToolResult } from '../../live-stream-rows';
  import SessionTree from './SessionTree.svelte';
  import ItemStream from './ItemStream.svelte';
  import InspectorPanel from './InspectorPanel.svelte';
  import { InfoTip, Popover, StatusDot } from '../ui';

  let filterProject = $state('');
  let filterAgent = $state('');
  let filterStatus = $state('');
  let filterFidelity = $state('');
  let activeOnly = $state(true);

  const sessions = $derived(getLiveSessions());
  const sessionsTotal = $derived(getLiveSessionsTotal());
  const sessionsLoading = $derived(getLiveSessionsLoading());
  const sessionsError = $derived(getLiveSessionsError());
  const sessionsHasMore = $derived(getLiveSessionsHasMore());
  const projects = $derived(getLiveProjects());
  const agents = $derived(getLiveAgents());
  const selectedSessionId = $derived(getSelectedLiveSessionId());
  const selectedSession = $derived(getSelectedLiveSession());
  const turns = $derived(getLiveTurns());
  const items = $derived(getLiveItems());
  const itemsLoading = $derived(getLiveItemsLoading());
  const itemsError = $derived(getLiveItemsError());
  const itemsHasMore = $derived(getLiveItemsHasMore());
  const selectedKinds = $derived(getSelectedLiveKinds());
  const selectedItemId = $derived(getSelectedLiveItemId());
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

  const sessionTree = $derived.by(() => buildSessionTree(sessions));

  function applyFilters(): void {
    setLiveFilters({
      project: filterProject,
      agent: filterAgent,
      live_status: filterStatus,
      fidelity: filterFidelity,
      active_only: activeOnly,
    });
    void loadLiveSessions();
  }

  function handleOpenHistory(): void {
    const session = selectedSession;
    if (!session) return;
    navigateToSession(session.id);
  }

  onMount(() => {
    void initializeLivePage().then(() => {
      if (getLiveSettings().enabled) {
        connectLiveSSE();
      }
    });

    return () => {
      disconnectLiveSSE();
      resetLiveState();
    };
  });
</script>

<main class="flex-1 overflow-y-auto p-4 sm:p-6 xl:flex xl:min-h-0 xl:flex-col xl:overflow-hidden">
  {#if !liveSettings.enabled}
    <div class="flex h-full items-center justify-center px-6">
      <div class="max-w-xl rounded-lg border border-line bg-surface p-6 text-center">
        <h2 class="text-h3">Live tab disabled</h2>
        <p class="mt-2 text-body text-text-muted">
          Enable `AGENTMONITOR_ENABLE_LIVE_TAB` to expose the live operator view and its dedicated v2 live APIs.
        </p>
      </div>
    </div>
  {:else}
  <div class="space-y-4 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:gap-4 xl:space-y-0">
    <section class="rounded-lg border border-line bg-surface xl:shrink-0">
      <div class="px-4 py-4 sm:px-5">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex items-center gap-1.5">
            <h2 class="text-h2">Live</h2>
            <InfoTip label="Live">
              <p>The item stream of active and recently updated sessions. Pick a session to follow it as it runs.</p>
            </InfoTip>
          </div>
          <div class="flex items-center gap-3">
            <span class="tabular font-mono text-meta text-text-faint">{sessionsTotal} tracked session{sessionsTotal === 1 ? '' : 's'}</span>
            <StatusDot status={connectionStatus} label={connectionStatus} />
          </div>
        </div>

        <div class="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
          <select
            class="rounded-sm border border-line bg-surface px-3 py-2 text-meta text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
            bind:value={filterProject}
            onchange={applyFilters}
          >
            <option value="">All Projects</option>
            {#each projects as project}
              <option value={project}>{project}</option>
            {/each}
          </select>

          <select
            class="rounded-sm border border-line bg-surface px-3 py-2 text-meta text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
            bind:value={filterAgent}
            onchange={applyFilters}
          >
            <option value="">All Agents</option>
            {#each agents as agent}
              <option value={agent}>{agent}</option>
            {/each}
          </select>

          <select
            class="rounded-sm border border-line bg-surface px-3 py-2 text-meta text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
            bind:value={filterStatus}
            onchange={applyFilters}
          >
            <option value="">Any Status</option>
            <option value="live">Live</option>
            <option value="active">Active</option>
            <option value="idle">Idle</option>
            <option value="ended">Ended</option>
          </select>

          <select
            class="rounded-sm border border-line bg-surface px-3 py-2 text-meta text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
            bind:value={filterFidelity}
            onchange={applyFilters}
          >
            <option value="">Any Fidelity</option>
            <option value="full">Full</option>
            <option value="summary">Summary</option>
          </select>
        </div>

        <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label class="flex items-center gap-2 text-meta text-text-muted">
            <input type="checkbox" class="accent-accent" bind:checked={activeOnly} onchange={applyFilters} />
            Active sessions first view
          </label>

          <Popover align="right" width="w-64" label="Capture settings">
            {#snippet trigger({ toggle, open })}
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-meta text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
                aria-haspopup="dialog"
                aria-expanded={open}
                onclick={toggle}
              >
                <span
                  class="h-1.5 w-1.5 rounded-full {captureAllOn ? 'bg-ok' : 'bg-warn'}"
                  aria-hidden="true"
                ></span>
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
    </section>

    <div class="flex flex-col gap-4 xl:min-h-0 xl:flex-1 xl:flex-row">
      <section class="flex min-h-[20rem] flex-col rounded-lg border border-line bg-surface xl:min-h-0 xl:w-[19rem] xl:shrink-0 xl:overflow-hidden">
        <div class="shrink-0 border-b border-line px-4 py-3">
          <h3 class="text-h3">Sessions</h3>
        </div>

        <div class="px-3 py-3 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
        <SessionTree
          sessions={sessionTree}
          {selectedSessionId}
          loading={sessionsLoading}
          error={sessionsError}
          hasMore={sessionsHasMore}
          onselect={(sessionId) => void selectLiveSession(sessionId)}
          onloadmore={() => void loadMoreLiveSessions()}
        />
        </div>
      </section>

      <section class="min-h-[24rem] rounded-lg border border-line bg-surface xl:min-h-0 xl:min-w-0 xl:flex-1 xl:overflow-hidden">
        <ItemStream
          session={selectedSession}
          {turns}
          {items}
          {selectedItemId}
          loading={itemsLoading}
          error={itemsError}
          hasMore={itemsHasMore}
          {selectedKinds}
          onselect={setSelectedLiveItem}
          ontogglekind={toggleLiveItemKind}
          onloadmore={() => void loadMoreLiveItems()}
          onopenhistory={handleOpenHistory}
        />
      </section>

      <section class="min-h-[20rem] rounded-lg border border-line bg-surface xl:min-h-0 xl:w-[22rem] xl:shrink-0 xl:overflow-hidden">
        <InspectorPanel session={selectedSession} {turns} item={selectedItem} result={selectedResult} />
      </section>
    </div>
  </div>
  {/if}
</main>
