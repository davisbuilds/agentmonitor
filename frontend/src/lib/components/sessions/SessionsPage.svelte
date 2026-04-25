<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchBrowsingSessions,
    fetchV2Projects,
    fetchV2Agents,
    type BrowsingSession,
  } from '../../api/client';
  import { timeAgo, agentHexColor } from '../../format';
  import { getSessionPreviewText } from '../../session-text';
  import {
    consumePendingSessionNavigation,
    getPendingSessionNavigationVersion,
  } from '../../stores/router.svelte';
  import { buildSessionsHash, parseSessionsHash } from '../../route-state';
  import SessionViewer from './SessionViewer.svelte';
  import ProjectionCapabilities from '../shared/ProjectionCapabilities.svelte';

  let sessions = $state<BrowsingSession[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let cursor = $state<string | undefined>();
  let hasMore = $state(false);

  // Filters
  let projects = $state<string[]>([]);
  let agents = $state<string[]>([]);
  let filterProject = $state('');
  let filterAgent = $state('');

  // Selected session
  let selectedSessionId = $state<string | null>(null);
  let selectedMessageOrdinal = $state<number | null>(null);

  const PAGE_SIZE = 25;
  const pendingNavigationVersion = $derived(getPendingSessionNavigationVersion());

  function currentRouteState() {
    return {
      project: filterProject,
      agent: filterAgent,
      sessionId: selectedSessionId,
      messageOrdinal: selectedMessageOrdinal,
    };
  }

  function syncHash(replace = false) {
    if (typeof window === 'undefined') return;
    const nextHash = buildSessionsHash(currentRouteState());
    const nextUrl = `${window.location.pathname}${window.location.search}#${nextHash}`;
    if (replace) {
      window.history.replaceState(null, '', nextUrl);
      return;
    }
    window.location.hash = nextHash;
  }

  function applyHashState(shouldLoadSessions: boolean) {
    if (typeof window === 'undefined') return;
    const next = parseSessionsHash(window.location.hash, currentRouteState());
    const filtersChanged = next.project !== filterProject || next.agent !== filterAgent;
    filterProject = next.project;
    filterAgent = next.agent;
    selectedSessionId = next.sessionId;
    selectedMessageOrdinal = next.messageOrdinal;
    if (filtersChanged && shouldLoadSessions) {
      cursor = undefined;
      void loadSessions();
    }
  }

  async function loadSessions(append = false) {
    loading = true;
    error = null;
    try {
      const params: Record<string, string | number> = { limit: PAGE_SIZE };
      if (filterProject) params.project = filterProject;
      if (filterAgent) params.agent = filterAgent;
      if (append && cursor) params.cursor = cursor;

      const res = await fetchBrowsingSessions(params);
      if (append) {
        sessions = [...sessions, ...res.data];
      } else {
        sessions = res.data;
      }
      total = res.total;
      cursor = res.cursor;
      hasMore = !!res.cursor && res.data.length === PAGE_SIZE;
    } catch (err) {
      console.error('Failed to load sessions:', err);
      error = 'Failed to load sessions. Check that the server is running.';
    } finally {
      loading = false;
    }
  }

  function handleFilterChange() {
    cursor = undefined;
    selectedSessionId = null;
    selectedMessageOrdinal = null;
    syncHash(true);
    loadSessions();
  }

  function selectSession(id: string) {
    selectedSessionId = id;
    selectedMessageOrdinal = null;
    syncHash();
  }

  function closeViewer() {
    selectedSessionId = null;
    selectedMessageOrdinal = null;
    syncHash();
  }

  $effect(() => {
    pendingNavigationVersion;
    const pending = consumePendingSessionNavigation();
    if (!pending.sessionId) return;
    selectedSessionId = pending.sessionId;
    selectedMessageOrdinal = pending.messageOrdinal;
  });

  onMount(() => {
    applyHashState(false);
    void Promise.all([
      fetchV2Projects().catch(() => ({ data: [] })),
      fetchV2Agents().catch(() => ({ data: [] })),
    ]).then(([projectsRes, agentsRes]) => {
      projects = projectsRes.data;
      agents = agentsRes.data;
      void loadSessions();
    });

    const handleHashChange = () => applyHashState(true);
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  });
</script>

{#if selectedSessionId}
  {#key selectedSessionId}
    <SessionViewer sessionId={selectedSessionId} initialMessageOrdinal={selectedMessageOrdinal} onclose={closeViewer} />
  {/key}
{:else}
  <main class="flex-1 overflow-hidden flex flex-col p-4 sm:p-6">
    <!-- Filters -->
    <div class="flex items-center gap-3 mb-4 flex-wrap">
      <h2 class="text-lg font-semibold text-gray-200 mr-2">Sessions</h2>
      <span class="text-sm text-gray-500">{total} total</span>

      <select
        class="bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded px-2 py-1"
        bind:value={filterProject}
        onchange={handleFilterChange}
      >
        <option value="">All Projects</option>
        {#each projects as p}
          <option value={p}>{p}</option>
        {/each}
      </select>

      <select
        class="bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded px-2 py-1"
        bind:value={filterAgent}
        onchange={handleFilterChange}
      >
        <option value="">All Agents</option>
        {#each agents as a}
          <option value={a}>{a}</option>
        {/each}
      </select>
    </div>

    <!-- Session List -->
    <div class="flex-1 overflow-y-auto space-y-1">
      {#each sessions as session (session.id)}
        <button
          class="w-full text-left px-3 py-2 rounded hover:bg-gray-800/60 transition-colors border border-transparent hover:border-gray-700/50 group"
          onclick={() => selectSession(session.id)}
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <span
                class="inline-block w-2 h-2 rounded-full shrink-0"
                style="background-color: {agentHexColor(session.agent)}"
              ></span>
              <span class="text-sm text-gray-300 truncate">
                {getSessionPreviewText(session.first_message) || (session.message_count > 0 ? 'Local command activity' : session.id.slice(0, 12))}
              </span>
            </div>
            <div class="flex items-center gap-3 shrink-0 text-xs text-gray-500">
              {#if session.project}
                <span class="bg-gray-800 px-1.5 py-0.5 rounded">{session.project}</span>
              {/if}
              <ProjectionCapabilities capabilities={session.capabilities} variant="summary" />
              <span>{session.message_count} msgs</span>
              {#if session.started_at}
                <span>{timeAgo(session.started_at)}</span>
              {/if}
            </div>
          </div>
        </button>
      {/each}

      {#if loading}
        <div class="text-center py-8 text-gray-500 text-sm">Loading sessions...</div>
      {:else if error}
        <div class="text-center py-16 text-red-400">
          <p class="text-sm">{error}</p>
          <button class="text-xs mt-2 text-blue-400 hover:text-blue-300" onclick={() => loadSessions()}>Retry</button>
        </div>
      {:else if sessions.length === 0}
        <div class="text-center py-16 text-gray-500">
          <p class="text-sm">No sessions found.</p>
          <p class="text-xs mt-1">Sessions are discovered from ~/.claude/projects/ JSONL files.</p>
        </div>
      {/if}

      {#if hasMore && !loading}
        <div class="text-center py-3">
          <button
            class="text-sm text-blue-400 hover:text-blue-300"
            onclick={() => loadSessions(true)}
          >
            Load more
          </button>
        </div>
      {/if}
    </div>
  </main>
{/if}
