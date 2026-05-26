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
  import { SectionHeader, Select, Badge, EmptyState, Button } from '../ui';

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
  let previousSelections = $state<Array<{ sessionId: string; messageOrdinal: number | null }>>([]);

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

  function sameSelection(
    left: { sessionId: string; messageOrdinal: number | null },
    right: { sessionId: string; messageOrdinal: number | null },
  ) {
    return left.sessionId === right.sessionId && left.messageOrdinal === right.messageOrdinal;
  }

  function rememberCurrentSelection(next: { sessionId: string; messageOrdinal: number | null }) {
    if (!selectedSessionId) return;

    const current = {
      sessionId: selectedSessionId,
      messageOrdinal: selectedMessageOrdinal,
    };
    if (sameSelection(current, next)) return;

    const last = previousSelections[previousSelections.length - 1];
    if (!last || !sameSelection(last, current)) {
      previousSelections = [...previousSelections, current];
    }
  }

  function selectSessionState(sessionId: string | null, messageOrdinal: number | null, trackPrevious = false) {
    if (sessionId && trackPrevious) {
      rememberCurrentSelection({ sessionId, messageOrdinal });
    }
    selectedSessionId = sessionId;
    selectedMessageOrdinal = messageOrdinal;
  }

  function applyRouteSelection(nextSessionId: string | null, nextMessageOrdinal: number | null) {
    if (!nextSessionId) {
      previousSelections = [];
      selectSessionState(null, null);
      return;
    }

    const next = { sessionId: nextSessionId, messageOrdinal: nextMessageOrdinal };
    const previous = previousSelections[previousSelections.length - 1];
    if (previous && sameSelection(previous, next)) {
      previousSelections = previousSelections.slice(0, -1);
    } else {
      rememberCurrentSelection(next);
    }
    selectSessionState(nextSessionId, nextMessageOrdinal);
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
    applyRouteSelection(next.sessionId, next.messageOrdinal);
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
    previousSelections = [];
    selectSessionState(null, null);
    syncHash(true);
    loadSessions();
  }

  function selectSession(id: string) {
    selectSessionState(id, null, true);
    syncHash();
  }

  function closeViewer() {
    const previous = previousSelections[previousSelections.length - 1];
    if (previous) {
      previousSelections = previousSelections.slice(0, -1);
      selectSessionState(previous.sessionId, previous.messageOrdinal);
      syncHash(true);
      return;
    }

    selectSessionState(null, null);
    syncHash();
  }

  $effect(() => {
    pendingNavigationVersion;
    const pending = consumePendingSessionNavigation();
    if (!pending.sessionId) return;
    selectSessionState(pending.sessionId, pending.messageOrdinal, true);
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
  <main class="flex-1 min-h-0 overflow-hidden flex flex-col p-4 sm:p-6">
    <!-- Filters -->
    <SectionHeader title="Sessions" count={`${total} total`}>
      {#snippet actions()}
        <Select
          bind:value={filterProject}
          options={projects}
          placeholder="All Projects"
          aria-label="Filter by project"
          onchange={handleFilterChange}
        />
        <Select
          bind:value={filterAgent}
          options={agents}
          placeholder="All Agents"
          aria-label="Filter by agent"
          onchange={handleFilterChange}
        />
      {/snippet}
    </SectionHeader>

    <!-- Session List -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="divide-y divide-line/60">
        {#each sessions as session (session.id)}
          <button
            class="group w-full rounded-sm px-2 py-2.5 text-left transition-colors hover:bg-surface"
            onclick={() => selectSession(session.id)}
          >
            <div class="flex items-center justify-between gap-3">
              <div class="flex min-w-0 flex-1 items-center gap-2">
                <span
                  class="inline-block h-2 w-2 shrink-0 rounded-full"
                  style="background-color: {agentHexColor(session.agent)}"
                ></span>
                <span class="truncate text-body text-text group-hover:text-text">
                  {getSessionPreviewText(session.first_message) || (session.message_count > 0 ? 'Local command activity' : session.id.slice(0, 12))}
                </span>
              </div>
              <div class="flex shrink-0 items-center gap-2 text-meta text-text-faint">
                {#if session.project}
                  <Badge tone="neutral">{session.project}</Badge>
                {/if}
                <ProjectionCapabilities capabilities={session.capabilities} variant="summary" />
                <span class="tabular font-mono">{session.message_count} msgs</span>
                {#if session.started_at}
                  <span class="tabular font-mono">{timeAgo(session.started_at)}</span>
                {/if}
              </div>
            </div>
          </button>
        {/each}
      </div>

      {#if loading}
        <div class="py-8 text-center text-meta text-text-muted">Loading sessions…</div>
      {:else if error}
        <EmptyState title={error}>
          {#snippet action()}
            <Button variant="neutral" size="sm" onclick={() => loadSessions()}>Retry</Button>
          {/snippet}
        </EmptyState>
      {:else if sessions.length === 0}
        <EmptyState
          title="No sessions found."
          description="Sessions are discovered from ~/.claude/projects/ JSONL files."
        />
      {/if}

      {#if hasMore && !loading}
        <div class="py-3 text-center">
          <Button variant="ghost" size="sm" onclick={() => loadSessions(true)}>Load more</Button>
        </div>
      {/if}
    </div>
  </main>
{/if}
