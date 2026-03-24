<script lang="ts">
  import { onMount } from 'svelte';
  import type { LiveSession } from '../../api/client';
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
  import SessionTree from './SessionTree.svelte';
  import ItemStream from './ItemStream.svelte';
  import InspectorPanel from './InspectorPanel.svelte';

  interface SessionTreeNode {
    session: LiveSession;
    depth: number;
  }

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
  const connectionStatus = $derived(getLiveConnectionStatus());
  const liveSettings = $derived(getLiveSettings());

  const sessionTree = $derived.by(() => buildSessionTree(sessions));

  function buildSessionTree(source: LiveSession[]): SessionTreeNode[] {
    const childrenByParent = new Map<string, LiveSession[]>();
    const roots: LiveSession[] = [];

    for (const session of source) {
      if (session.parent_session_id && source.some(candidate => candidate.id === session.parent_session_id)) {
        const children = childrenByParent.get(session.parent_session_id) || [];
        children.push(session);
        childrenByParent.set(session.parent_session_id, children);
      } else {
        roots.push(session);
      }
    }

    const flattened: SessionTreeNode[] = [];
    const visited = new Set<string>();

    function visit(session: LiveSession, depth: number): void {
      if (visited.has(session.id)) return;
      visited.add(session.id);
      flattened.push({ session, depth });
      const children = childrenByParent.get(session.id) || [];
      for (const child of children) visit(child, depth + 1);
    }

    for (const root of roots) visit(root, 0);
    for (const session of source) visit(session, 0);

    return flattened;
  }

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

<main class="flex-1 overflow-hidden bg-gray-950">
  {#if !liveSettings.enabled}
    <div class="flex h-full items-center justify-center px-6">
      <div class="max-w-xl rounded-2xl border border-gray-800 bg-gray-900/70 p-6 text-center">
        <h2 class="text-lg font-semibold text-gray-100">Live tab disabled</h2>
        <p class="mt-2 text-sm text-gray-400">
          Enable `AGENTMONITOR_ENABLE_LIVE_TAB` to expose the live operator view and its dedicated v2 live APIs.
        </p>
      </div>
    </div>
  {:else}
  <div class="grid h-full grid-cols-1 xl:grid-cols-[19rem,minmax(0,1fr),22rem]">
    <section class="border-b border-gray-800 xl:border-b-0 xl:border-r overflow-hidden flex flex-col">
      <div class="border-b border-gray-800 px-4 py-3 shrink-0">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-base font-semibold text-gray-100">Live</h2>
            <p class="mt-1 text-xs text-gray-500">{sessionsTotal} tracked session{sessionsTotal === 1 ? '' : 's'}</p>
          </div>
          <span class="rounded-full border px-2 py-1 text-[10px] uppercase tracking-wide {connectionStatus === 'connected' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : connectionStatus === 'connecting' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-red-500/30 bg-red-500/10 text-red-300'}">
            {connectionStatus}
          </span>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-2">
          <select
            class="rounded border border-gray-700 bg-gray-900 px-2 py-2 text-sm text-gray-300"
            bind:value={filterProject}
            onchange={applyFilters}
          >
            <option value="">All Projects</option>
            {#each projects as project}
              <option value={project}>{project}</option>
            {/each}
          </select>

          <select
            class="rounded border border-gray-700 bg-gray-900 px-2 py-2 text-sm text-gray-300"
            bind:value={filterAgent}
            onchange={applyFilters}
          >
            <option value="">All Agents</option>
            {#each agents as agent}
              <option value={agent}>{agent}</option>
            {/each}
          </select>

          <select
            class="rounded border border-gray-700 bg-gray-900 px-2 py-2 text-sm text-gray-300"
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
            class="rounded border border-gray-700 bg-gray-900 px-2 py-2 text-sm text-gray-300"
            bind:value={filterFidelity}
            onchange={applyFilters}
          >
            <option value="">Any Fidelity</option>
            <option value="full">Full</option>
            <option value="summary">Summary</option>
          </select>
        </div>

        <label class="mt-3 flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" bind:checked={activeOnly} onchange={applyFilters} />
          Active sessions first view
        </label>

        <div class="mt-3 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-3 text-xs text-gray-400">
          <div class="flex items-center justify-between gap-3">
            <span class="uppercase tracking-wide text-gray-500">Capture</span>
            <span class="uppercase tracking-wide text-gray-500">Codex: {liveSettings.codex_mode}</span>
          </div>
          <div class="mt-2 flex flex-wrap gap-2">
            <span class="rounded border px-1.5 py-0.5 {liveSettings.capture.prompts ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-gray-700 text-gray-500'}">Prompts {liveSettings.capture.prompts ? 'on' : 'off'}</span>
            <span class="rounded border px-1.5 py-0.5 {liveSettings.capture.reasoning ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-gray-700 text-gray-500'}">Reasoning {liveSettings.capture.reasoning ? 'on' : 'off'}</span>
            <span class="rounded border px-1.5 py-0.5 {liveSettings.capture.tool_arguments ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-gray-700 text-gray-500'}">Tool args {liveSettings.capture.tool_arguments ? 'on' : 'off'}</span>
          </div>
          <div class="mt-2 text-[11px] text-gray-500">
            Diff payload cap: {liveSettings.diff_payload_max_bytes.toLocaleString()} bytes
          </div>
        </div>
      </div>

      <div class="min-h-0 flex-1 px-3 py-3">
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

    <section class="min-h-0 overflow-hidden">
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

    <section class="min-h-0">
      <InspectorPanel session={selectedSession} {turns} item={selectedItem} />
    </section>
  </div>
  {/if}
</main>
