<script lang="ts">
  import {
    searchMessages,
    fetchV2Projects,
    fetchV2Agents,
    type SearchResult,
  } from '../../api/client';
  import { setTab } from '../../stores/router.svelte';

  let query = $state('');
  let results = $state<SearchResult[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let searched = $state(false);
  let cursor = $state<string | undefined>();
  let hasMore = $state(false);

  // Filters
  let projects = $state<string[]>([]);
  let agents = $state<string[]>([]);
  let filterProject = $state('');
  let filterAgent = $state('');

  const PAGE_SIZE = 25;

  // Load filter options
  import { onMount } from 'svelte';
  onMount(async () => {
    const [p, a] = await Promise.all([
      fetchV2Projects().catch(() => ({ data: [] })),
      fetchV2Agents().catch(() => ({ data: [] })),
    ]);
    projects = p.data;
    agents = a.data;
  });

  async function search(append = false) {
    if (!query.trim()) return;
    loading = true;
    searched = true;
    try {
      const params: { q: string; project?: string; agent?: string; limit?: number; cursor?: string } = {
        q: query.trim(),
        limit: PAGE_SIZE,
      };
      if (filterProject) params.project = filterProject;
      if (filterAgent) params.agent = filterAgent;
      if (append && cursor) params.cursor = cursor;

      const res = await searchMessages(params);
      if (append) {
        results = [...results, ...res.data];
      } else {
        results = res.data;
      }
      total = res.total;
      cursor = res.cursor;
      hasMore = !!res.cursor && res.data.length === PAGE_SIZE;
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      loading = false;
    }
  }

  function handleSubmit(e: Event) {
    e.preventDefault();
    cursor = undefined;
    search();
  }

  function navigateToSession(sessionId: string) {
    // Switch to sessions tab - the session viewer will need to handle this
    setTab('sessions');
  }
</script>

<main class="flex-1 overflow-hidden flex flex-col p-4 sm:p-6">
  <!-- Search bar -->
  <form class="flex items-center gap-3 mb-4 flex-wrap" onsubmit={handleSubmit}>
    <div class="flex-1 min-w-[200px]">
      <input
        type="text"
        placeholder="Search across all conversations..."
        class="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded px-3 py-2 focus:outline-none focus:border-blue-500"
        bind:value={query}
      />
    </div>

    <select
      class="bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded px-2 py-2"
      bind:value={filterProject}
    >
      <option value="">All Projects</option>
      {#each projects as p}
        <option value={p}>{p}</option>
      {/each}
    </select>

    <select
      class="bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded px-2 py-2"
      bind:value={filterAgent}
    >
      <option value="">All Agents</option>
      {#each agents as a}
        <option value={a}>{a}</option>
      {/each}
    </select>

    <button
      type="submit"
      class="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded transition-colors"
      disabled={loading || !query.trim()}
    >
      {loading ? 'Searching...' : 'Search'}
    </button>
  </form>

  {#if searched}
    <div class="text-xs text-gray-500 mb-3">{total} result{total !== 1 ? 's' : ''}</div>
  {/if}

  <!-- Results -->
  <div class="flex-1 overflow-y-auto space-y-2">
    {#each results as result (result.message_id)}
      <button
        class="w-full text-left px-3 py-2 rounded bg-gray-900/40 hover:bg-gray-800/60 border border-gray-800 hover:border-gray-700 transition-colors"
        onclick={() => navigateToSession(result.session_id)}
      >
        <div class="flex items-center gap-2 mb-1 text-xs text-gray-500">
          <span class="{result.message_role === 'user' ? 'text-blue-400' : 'text-green-400'}">
            {result.message_role}
          </span>
          <span>·</span>
          <span class="font-mono">{result.session_id.slice(0, 8)}</span>
          <span>·</span>
          <span>msg #{result.message_ordinal}</span>
        </div>
        <div class="text-sm text-gray-300 line-clamp-2">
          {@html result.snippet}
        </div>
      </button>
    {/each}

    {#if searched && !loading && results.length === 0}
      <div class="text-center py-16 text-gray-500 text-sm">
        No results found for "{query}".
      </div>
    {/if}

    {#if hasMore && !loading}
      <div class="text-center py-3">
        <button
          class="text-sm text-blue-400 hover:text-blue-300"
          onclick={() => search(true)}
        >
          Load more results
        </button>
      </div>
    {/if}
  </div>
</main>
