<script lang="ts">
  import { onMount } from 'svelte';
  import { agentHexColor, timeAgo } from '../../format';
  import { getSessionPreviewText } from '../../session-text';
  import { openCommandPalette } from '../../stores/router.svelte';
  import { search } from '../../stores/search.svelte';

  function sanitizeSnippet(html: string): string {
    return html
      .replace(/<mark>/g, '\x00MARK_OPEN\x00')
      .replace(/<\/mark>/g, '\x00MARK_CLOSE\x00')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\x00MARK_OPEN\x00/g, '<mark>')
      .replace(/\x00MARK_CLOSE\x00/g, '</mark>');
  }

  function sessionPreview(session: { first_message: string | null; message_count: number; id: string }): string {
    return getSessionPreviewText(session.first_message)
      || (session.message_count > 0 ? 'Local command activity' : session.id.slice(0, 12));
  }

  const searchNotice = $derived.by(() => {
    if (search.agent === 'codex') {
      return {
        tone: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
        title: 'Codex search is partial.',
        body: 'This tab indexes transcript-backed history only. Summary-only Codex live sessions remain intentionally excluded until richer Codex transcript ingestion exists.',
      };
    }

    return {
      tone: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
      title: 'Search is capability-aware.',
      body: 'Only sessions with searchable history appear here. Summary-only live sessions do not contribute to full-text results.',
    };
  });

  onMount(() => {
    void search.initialize();
    return () => search.dispose();
  });
</script>

<main class="flex-1 overflow-hidden flex flex-col p-4 sm:p-6">
  <div class={`mb-4 rounded-xl border px-4 py-3 text-sm ${searchNotice.tone}`}>
    <div class="font-medium">{searchNotice.title}</div>
    <p class="mt-1 text-xs text-gray-300">{searchNotice.body}</p>
  </div>

  <div class="mb-4 flex flex-wrap items-start gap-3">
    <div class="min-w-[260px] flex-1">
      <input
        type="text"
        placeholder="Search across transcript history..."
        class="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
        value={search.query}
        oninput={(event) => search.setQuery((event.currentTarget as HTMLInputElement).value)}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void search.searchNow(false);
          }
        }}
      />
      <p class="mt-2 text-xs text-gray-500">Results update automatically after a short pause. Press Enter to run immediately.</p>
    </div>

    <button
      type="button"
      class="rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-300 transition hover:border-gray-600 hover:text-gray-100"
      onclick={() => openCommandPalette()}
    >
      Command Palette
    </button>

    <select
      class="rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-300"
      value={search.sort}
      onchange={(event) => search.setSort((event.currentTarget as HTMLSelectElement).value as 'recent' | 'relevance')}
    >
      <option value="recent">Newest First</option>
      <option value="relevance">Best Match</option>
    </select>

    <select
      class="rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-300"
      value={search.project}
      onchange={(event) => search.setProject((event.currentTarget as HTMLSelectElement).value)}
    >
      <option value="">All Projects</option>
      {#each search.projectOptions as project}
        <option value={project}>{project}</option>
      {/each}
    </select>

    <select
      class="rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-300"
      value={search.agent}
      onchange={(event) => search.setAgent((event.currentTarget as HTMLSelectElement).value)}
    >
      <option value="">All Agents</option>
      {#each search.agentOptions as agent}
        <option value={agent}>{agent}</option>
      {/each}
    </select>
  </div>

  {#if search.hasQuery}
    <div class="mb-3 flex items-center justify-between gap-3 text-xs text-gray-500">
      <span>{search.total} result{search.total === 1 ? '' : 's'}</span>
      <span>{search.sort === 'relevance' ? 'Sorted by best match' : 'Sorted by newest match'}</span>
    </div>
  {:else}
    <div class="mb-3 flex items-center justify-between gap-3 text-xs text-gray-500">
      <span>Recent sessions</span>
      <span>{search.project || search.agent ? 'Filtered by current selectors' : 'No query yet'}</span>
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto">
    {#if search.hasQuery}
      <div class="space-y-2">
        {#each search.results as result (result.message_id)}
          <button
            class="w-full rounded-xl border border-gray-800 bg-gray-900/40 px-3 py-3 text-left transition-colors hover:border-gray-700 hover:bg-gray-800/60"
            onclick={() => search.openResult(result)}
          >
            <div class="mb-1 flex items-center justify-between gap-3 text-xs text-gray-500">
              <div class="min-w-0 flex items-center gap-2">
                <span
                  class="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={`background-color:${agentHexColor(result.session_agent)}`}
                ></span>
                <span class="truncate">{result.session_project || result.session_agent}</span>
                <span>·</span>
                <span class={result.message_role === 'user' ? 'text-blue-400' : 'text-green-400'}>
                  {result.message_role}
                </span>
                <span>·</span>
                <span>msg #{result.message_ordinal}</span>
              </div>
              <div class="shrink-0">
                {#if result.session_started_at}
                  {timeAgo(result.session_started_at)}
                {:else}
                  <span class="font-mono">{result.session_id.slice(0, 8)}</span>
                {/if}
              </div>
            </div>
            <div class="text-sm text-gray-300 line-clamp-2">
              {@html sanitizeSnippet(result.snippet)}
            </div>
            {#if result.session_first_message}
              <div class="mt-2 truncate text-xs text-gray-500">
                {getSessionPreviewText(result.session_first_message)}
              </div>
            {/if}
          </button>
        {/each}

        {#if search.loading && search.results.length === 0}
          <div class="py-16 text-center text-sm text-gray-500">Searching transcript history...</div>
        {:else if search.error}
          <div class="py-10 text-center text-sm text-red-300">{search.error}</div>
        {:else if search.searched && !search.loading && search.results.length === 0}
          <div class="py-16 text-center text-sm text-gray-500">
            No transcript matches found for "{search.query}".
          </div>
        {/if}

        {#if search.hasMore && !search.loading}
          <div class="py-3 text-center">
            <button
              class="text-sm text-blue-400 transition hover:text-blue-300"
              onclick={() => search.loadMore()}
            >
              Load more results
            </button>
          </div>
        {/if}
      </div>
    {:else}
      <div class="space-y-2">
        {#each search.recentSessions as session (session.id)}
          <button
            class="w-full rounded-xl border border-gray-800 bg-gray-900/40 px-3 py-3 text-left transition-colors hover:border-gray-700 hover:bg-gray-800/60"
            onclick={() => search.openSession(session.id)}
          >
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0 flex items-center gap-2">
                <span
                  class="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={`background-color:${agentHexColor(session.agent)}`}
                ></span>
                <span class="truncate text-sm text-gray-200">{sessionPreview(session)}</span>
              </div>
              <div class="flex shrink-0 items-center gap-3 text-xs text-gray-500">
                {#if session.project}
                  <span>{session.project}</span>
                {/if}
                <span>{session.message_count} msgs</span>
                {#if session.started_at}
                  <span>{timeAgo(session.started_at)}</span>
                {/if}
              </div>
            </div>
          </button>
        {/each}

        {#if search.recentLoading}
          <div class="py-16 text-center text-sm text-gray-500">Loading recent sessions...</div>
        {:else if search.recentError}
          <div class="py-10 text-center text-sm text-red-300">{search.recentError}</div>
        {:else if search.recentSessions.length === 0}
          <div class="py-16 text-center text-sm text-gray-500">No sessions match the current filters.</div>
        {/if}
      </div>
    {/if}
  </div>
</main>
