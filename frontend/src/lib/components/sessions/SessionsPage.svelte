<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchSessionChildren,
    fetchV2Projects,
    fetchV2Agents,
    type BrowsingSession,
    type PinnedMessage,
    type SearchResult,
  } from '../../api/client';
  import { timeAgo, agentHexColor } from '../../format';
  import { sessionTitle } from '../../session-text';
  import {
    consumePendingSessionNavigation,
    getPendingSessionNavigationVersion,
  } from '../../stores/router.svelte';
  import { buildSessionsHash, parseSessionsHash, type SessionsRouteState, type SessionsSearchSort } from '../../route-state';
  import { filterPinnedMessages, sessionsListMode, startsSearch } from '../../sessions-browse';
  import { SessionList } from '../../stores/session-list.svelte';
  import { createSearchStore } from '../../stores/search.svelte';
  import { pins } from '../../stores/pins.svelte';
  import SessionViewer from './SessionViewer.svelte';
  import SearchResults from './SearchResults.svelte';
  import PinnedMessages from './PinnedMessages.svelte';
  import SessionCoverage from '../shared/SessionCoverage.svelte';
  import { Select, Badge, EmptyState, Button, InfoTip, FilterBar } from '../ui';

  const list = new SessionList();
  // Full-text results for the query box. The page owns the URL, so the store
  // only searches; with no query the session list shows instead.
  const search = createSearchStore({ recentLimit: 0 });

  const sortOptions = [
    { value: 'recent', label: 'Newest First' },
    { value: 'relevance', label: 'Best Match' },
  ];

  // Filters
  let projects = $state<string[]>([]);
  let agents = $state<string[]>([]);
  let filterProject = $state('');
  let filterAgent = $state('');
  let query = $state('');
  let sort = $state<SessionsSearchSort>('recent');
  let pinned = $state(false);

  const mode = $derived(sessionsListMode({ query, pinned }));
  const visiblePins = $derived(filterPinnedMessages(pins.pins, { project: filterProject, agent: filterAgent, query }));
  const countLabel = $derived.by(() => {
    if (mode === 'pinned') return `${visiblePins.length} pinned`;
    if (mode === 'search') {
      return search.searched ? `${search.total} result${search.total === 1 ? '' : 's'}` : '';
    }
    return `${list.total} total`;
  });
  const searchNote = $derived.by(() => {
    if (filterAgent === 'codex') {
      return 'Only Codex sessions with a rollout file are searchable; ones known only from telemetry have no text to search.';
    }
    if (filterAgent === 'antigravity') {
      return 'Antigravity sessions are searchable by step kind (such as "run command"), not by what was said.';
    }
    return 'Sessions known only from telemetry have no text to search.';
  });

  // Subagents shown under their parent row, by parent id.
  let expandedChildren = $state<Record<string, BrowsingSession[] | 'loading' | 'error'>>({});

  async function toggleChildren(parentId: string) {
    if (expandedChildren[parentId] && expandedChildren[parentId] !== 'error') {
      const { [parentId]: _collapsed, ...rest } = expandedChildren;
      expandedChildren = rest;
      return;
    }
    expandedChildren = { ...expandedChildren, [parentId]: 'loading' };
    try {
      const { data } = await fetchSessionChildren(parentId);
      expandedChildren = { ...expandedChildren, [parentId]: data };
    } catch (err) {
      console.error('Failed to load subagents:', err);
      expandedChildren = { ...expandedChildren, [parentId]: 'error' };
    }
  }

  // Selected session
  let selectedSessionId = $state<string | null>(null);
  let selectedMessageOrdinal = $state<number | null>(null);
  let previousSelections = $state<Array<{ sessionId: string; messageOrdinal: number | null }>>([]);

  const pendingNavigationVersion = $derived(getPendingSessionNavigationVersion());

  function currentRouteState(): SessionsRouteState {
    return {
      query,
      sort,
      project: filterProject,
      agent: filterAgent,
      pinned,
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

  function applyHashState(shouldLoad: boolean) {
    if (typeof window === 'undefined') return;
    const next = parseSessionsHash(window.location.hash, currentRouteState());
    const filtersChanged = next.project !== filterProject || next.agent !== filterAgent;
    const searchChanged = filtersChanged || next.query !== query || next.sort !== sort || next.pinned !== pinned;
    const pinnedTurnedOn = next.pinned && !pinned;
    filterProject = next.project;
    filterAgent = next.agent;
    query = next.query;
    sort = next.sort;
    pinned = next.pinned;
    applyRouteSelection(next.sessionId, next.messageOrdinal);
    if (!shouldLoad) return;
    if (filtersChanged) void loadSessions();
    if (searchChanged) syncSearch(true);
    if (pinnedTurnedOn) void pins.loadAll();
  }

  function loadSessions(append = false) {
    return list.load({ project: filterProject, agent: filterAgent, append });
  }

  /** Full-text search runs only while its results show; otherwise it clears. */
  function syncSearch(immediate: boolean) {
    search.update(
      { query: mode === 'search' ? query : '', project: filterProject, agent: filterAgent, sort },
      { immediate },
    );
  }

  function handleFilterChange() {
    previousSelections = [];
    selectSessionState(null, null);
    syncHash(true);
    void loadSessions();
    syncSearch(true);
  }

  const hasActiveFilters = $derived(Boolean(filterProject || filterAgent || pinned || query));

  function clearFilters() {
    const filtersChanged = Boolean(filterProject || filterAgent);
    filterProject = '';
    filterAgent = '';
    pinned = false;
    query = '';
    syncHash(true);
    if (filtersChanged) void loadSessions();
    syncSearch(true);
  }

  function handleQueryInput(next: string) {
    // Starting a search adds a history entry so Back returns to the list;
    // later keystrokes replace it.
    const push = startsSearch(query, next);
    query = next;
    syncHash(!push);
    syncSearch(false);
  }

  function handleSortChange(next: SessionsSearchSort) {
    sort = next;
    syncHash(true);
    syncSearch(true);
  }

  function togglePinned() {
    pinned = !pinned;
    syncHash(true);
    syncSearch(true);
    if (pinned) void pins.loadAll();
  }

  /** Open a result or pin at its message, keeping the search in the hash so closing the viewer returns to it. */
  function openMessage(sessionId: string, messageOrdinal: number) {
    selectSessionState(sessionId, messageOrdinal, true);
    syncHash();
  }

  function openResult(result: SearchResult) {
    openMessage(result.session_id, result.message_ordinal);
  }

  function openPin(pin: PinnedMessage) {
    openMessage(pin.session_id, pin.message_ordinal);
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
    syncSearch(true);
    if (pinned) void pins.loadAll();

    const handleHashChange = () => applyHashState(true);
    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      search.dispose();
    };
  });
</script>

{#if selectedSessionId}
  {#key selectedSessionId}
    <SessionViewer
      sessionId={selectedSessionId}
      initialMessageOrdinal={selectedMessageOrdinal}
      onclose={closeViewer}
      onselectsession={selectSession}
    />
  {/key}
{:else}
  <FilterBar>
    <input
      type="search"
      aria-label="Search transcripts"
      placeholder={pinned ? 'Search pinned messages…' : 'Search transcripts…'}
      class="w-64 min-w-0 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-meta text-text transition-colors placeholder:text-text-faint hover:border-line-strong focus:border-accent focus:outline-none"
      value={query}
      oninput={(event) => handleQueryInput((event.currentTarget as HTMLInputElement).value)}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          syncSearch(true);
        }
      }}
    />
    {#if mode === 'search'}
      <Select
        value={sort}
        options={sortOptions}
        aria-label="Sort results"
        onchange={(value) => handleSortChange(value as SessionsSearchSort)}
      />
    {/if}
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
    <button
      type="button"
      aria-pressed={pinned}
      class="shrink-0 rounded-sm border px-2.5 py-1.5 text-meta transition-colors {pinned ? 'border-accent/60 bg-accent/10 text-text' : 'border-line bg-surface text-text-muted hover:border-line-strong hover:text-text'}"
      onclick={togglePinned}
    >Pinned</button>

    {#snippet end()}
      {#if hasActiveFilters}
        <Button variant="ghost" size="sm" onclick={clearFilters}>Clear</Button>
      {/if}
    {/snippet}
  </FilterBar>

  <main class="flex-1 min-h-0 overflow-hidden flex flex-col p-4 sm:p-6">
    <div class="mb-3 flex items-baseline gap-2">
      <div class="flex items-center gap-1.5 self-center">
        <h2 class="text-h2">Sessions</h2>
        <InfoTip label="Sessions" width="w-96">
          <p>Type in the search box to search the text of recorded transcripts; matching messages replace the list until you clear it. Results update after a short pause, or press Enter. {searchNote}</p>
          <p>Pinned shows the messages you pinned in a session. With it on, the search box narrows them by their words instead.</p>
        </InfoTip>
      </div>
      {#if countLabel}<span class="tabular text-meta text-text-muted">{countLabel}</span>{/if}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if mode === 'search'}
        <SearchResults {search} onopen={openResult} />
      {:else if mode === 'pinned'}
        <PinnedMessages visible={visiblePins} onopen={openPin} />
      {:else}
      <!-- Session List -->
        <div class="divide-y divide-line/60">
          {#each list.sessions as session (session.id)}
            {@const childState = expandedChildren[session.id]}
            <div>
              <div class="flex items-center gap-1">
                <button
                  class="group min-w-0 flex-1 rounded-sm px-2 py-2.5 text-left transition-colors hover:bg-surface"
                  onclick={() => selectSession(session.id)}
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex min-w-0 flex-1 items-center gap-2">
                      <span
                        class="inline-block h-2 w-2 shrink-0 rounded-full"
                        style="background-color: {agentHexColor(session.agent)}"
                      ></span>
                      <span class="truncate text-body text-text group-hover:text-text">{sessionTitle(session)}</span>
                    </div>
                    <div class="flex shrink-0 items-center gap-2 text-meta text-text-faint">
                      {#if session.project}
                        <Badge tone="neutral">{session.project}</Badge>
                      {/if}
                      <SessionCoverage capabilities={session.capabilities} variant="row" />
                      <span class="tabular font-mono">{session.message_count} msgs</span>
                      {#if session.started_at}
                        <span class="tabular font-mono">{timeAgo(session.started_at)}</span>
                      {/if}
                    </div>
                  </div>
                </button>
                {#if session.child_count}
                  <button
                    type="button"
                    class="shrink-0 rounded-sm px-2 py-1 text-meta text-text-faint transition-colors hover:bg-surface hover:text-text"
                    aria-expanded={childState !== undefined && childState !== 'error'}
                    onclick={() => toggleChildren(session.id)}
                  >
                    {session.child_count} {session.child_count === 1 ? 'subagent' : 'subagents'}
                  </button>
                {/if}
              </div>
              {#if childState === 'loading'}
                <div class="py-1.5 pl-7 text-meta text-text-faint">Loading subagents…</div>
              {:else if childState === 'error'}
                <div class="py-1.5 pl-7 text-meta text-danger">Could not load subagents.</div>
              {:else if childState}
                <div class="mb-1 ml-3 border-l border-line pl-2">
                  {#each childState as child (child.id)}
                    <button
                      class="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-surface"
                      onclick={() => selectSession(child.id)}
                    >
                      <span class="truncate text-meta text-text-muted">{sessionTitle(child)}</span>
                      <span class="shrink-0 tabular font-mono text-meta text-text-faint">{child.message_count} msgs</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>

        {#if list.loading}
          <div class="py-8 text-center text-meta text-text-muted">Loading sessions…</div>
        {:else if list.error}
          <EmptyState title={list.error}>
            {#snippet action()}
              <Button variant="neutral" size="sm" onclick={() => loadSessions()}>Retry</Button>
            {/snippet}
          </EmptyState>
        {:else if list.sessions.length === 0}
          <EmptyState
            title="No sessions found."
            description="Sessions are discovered from ~/.claude/projects/ JSONL files."
          />
        {/if}

        {#if list.hasMore && !list.loading}
          <div class="py-3 text-center">
            <Button variant="ghost" size="sm" onclick={() => loadSessions(true)}>Load more</Button>
          </div>
        {/if}
      {/if}
    </div>
  </main>
{/if}
