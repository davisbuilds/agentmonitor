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
  import { Badge } from '../ui';

  type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger';
  function connectionTone(status: string): BadgeTone {
    if (status === 'connected') return 'ok';
    if (status === 'connecting') return 'warn';
    return 'danger';
  }

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
          <div>
            <h2 class="text-h2">Live</h2>
            <p class="mt-0.5 text-meta text-text-muted">
              Operator-focused stream for active and recently updated sessions.
            </p>
          </div>
          <div class="flex items-center gap-3">
            <span class="tabular font-mono text-meta text-text-faint">{sessionsTotal} tracked session{sessionsTotal === 1 ? '' : 's'}</span>
            <Badge tone={connectionTone(connectionStatus)} class="uppercase tracking-wide">{connectionStatus}</Badge>
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

          <div class="rounded-sm border border-line bg-surface-2 px-3 py-3 text-meta text-text-muted">
            <div class="flex items-center justify-between gap-3">
              <span class="uppercase tracking-wide text-text-faint">Capture</span>
              <span class="uppercase tracking-wide text-text-faint">Codex: {liveSettings.codex_mode}</span>
            </div>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <Badge tone={liveSettings.capture.prompts ? 'ok' : 'neutral'}>Prompts {liveSettings.capture.prompts ? 'on' : 'off'}</Badge>
              <Badge tone={liveSettings.capture.reasoning ? 'ok' : 'neutral'}>Reasoning {liveSettings.capture.reasoning ? 'on' : 'off'}</Badge>
              <Badge tone={liveSettings.capture.tool_arguments ? 'ok' : 'neutral'}>Tool args {liveSettings.capture.tool_arguments ? 'on' : 'off'}</Badge>
            </div>
            <div class="mt-2 tabular font-mono text-meta text-text-faint">
              Diff payload cap: {liveSettings.diff_payload_max_bytes.toLocaleString()} bytes
            </div>
          </div>
        </div>
      </div>
    </section>

    <div class="flex flex-col gap-4 xl:min-h-0 xl:flex-1 xl:flex-row">
      <section class="flex min-h-[20rem] flex-col rounded-lg border border-line bg-surface xl:min-h-0 xl:w-[19rem] xl:shrink-0 xl:overflow-hidden">
        <div class="shrink-0 border-b border-line px-4 py-3">
          <h3 class="text-h3">Sessions</h3>
          <p class="mt-0.5 text-meta text-text-muted">
            Filtered live and recent sessions. Select one to inspect its stream.
          </p>
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
        <InspectorPanel session={selectedSession} {turns} item={selectedItem} />
      </section>
    </div>
  </div>
  {/if}
</main>
