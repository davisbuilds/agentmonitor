<script lang="ts">
  import { onMount } from 'svelte';
  import { agentHexColor, timeAgo } from '../../format';
  import { getSessionPreviewText } from '../../session-text';
  import { openCommandPalette } from '../../stores/router.svelte';
  import { search } from '../../stores/search.svelte';
  import { Select, Button, EmptyState } from '../ui';
  import TraceDrillInLink from '../trace-quality/TraceDrillInLink.svelte';

  const sortOptions = [
    { value: 'recent', label: 'Newest First' },
    { value: 'relevance', label: 'Best Match' },
  ];

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
        dot: 'bg-warn',
        title: 'Codex search is partial.',
        body: 'Transcript-backed history only — summary-only Codex live sessions are excluded until richer Codex ingestion exists.',
      };
    }

    if (search.agent === 'antigravity') {
      return {
        dot: 'bg-warn',
        title: 'Antigravity search is partial.',
        body: 'Summary fidelity — only step kinds are indexed (e.g. "run command"), not transcript text, until conversation payload internals are decoded.',
      };
    }

    return {
      dot: 'bg-accent',
      title: 'Search is capability-aware.',
      body: 'Only sessions with searchable history appear here; summary-only live sessions do not contribute to full-text results.',
    };
  });

  onMount(() => {
    void search.initialize();
    return () => search.dispose();
  });
</script>

<main class="flex-1 overflow-hidden flex flex-col p-4 sm:p-6">
  <div class="mb-4 flex max-w-[72ch] items-start gap-2 text-meta">
    <span class="mt-1 h-2 w-2 shrink-0 rounded-full {searchNotice.dot}"></span>
    <p class="text-text-muted">
      <span class="font-medium text-text">{searchNotice.title}</span>
      {searchNotice.body}
    </p>
  </div>

  <div class="mb-4 flex flex-wrap items-start gap-3">
    <div class="min-w-[260px] flex-1">
      <input
        type="text"
        placeholder="Search across transcript history…"
        class="w-full rounded-sm border border-line bg-surface px-3 py-2 text-body text-text transition-colors placeholder:text-text-faint hover:border-line-strong focus:border-accent focus:outline-none"
        value={search.query}
        oninput={(event) => search.setQuery((event.currentTarget as HTMLInputElement).value)}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void search.searchNow(false);
          }
        }}
      />
      <p class="mt-2 text-meta text-text-faint">Results update automatically after a short pause. Press Enter to run immediately.</p>
    </div>

    <Button variant="neutral" onclick={() => openCommandPalette()}>Command Palette</Button>

    <Select
      value={search.sort}
      options={sortOptions}
      aria-label="Sort results"
      onchange={(value) => search.setSort(value as 'recent' | 'relevance')}
    />

    <Select
      value={search.project}
      options={search.projectOptions}
      placeholder="All Projects"
      aria-label="Filter by project"
      onchange={(value) => search.setProject(value)}
    />

    <Select
      value={search.agent}
      options={search.agentOptions}
      placeholder="All Agents"
      aria-label="Filter by agent"
      onchange={(value) => search.setAgent(value)}
    />
  </div>

  {#if search.hasQuery}
    <div class="mb-3 flex items-center justify-between gap-3 text-meta text-text-faint">
      <span class="tabular">{search.total} result{search.total === 1 ? '' : 's'}</span>
      <span>{search.sort === 'relevance' ? 'Sorted by best match' : 'Sorted by newest match'}</span>
    </div>
  {:else}
    <div class="mb-3 flex items-center justify-between gap-3 text-meta text-text-faint">
      <span>Recent sessions</span>
      <span>{search.project || search.agent ? 'Filtered by current selectors' : 'No query yet'}</span>
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto">
    {#if search.hasQuery}
      <div class="space-y-2">
        {#each search.results as result (result.message_id)}
          <div class="relative">
          <TraceDrillInLink sessionId={result.session_id} class="absolute right-2 bottom-2 z-10 bg-surface" />
          <button
            class="w-full rounded-sm border border-line bg-surface px-3 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
            onclick={() => search.openResult(result)}
          >
            <div class="mb-1 flex items-center justify-between gap-3 text-meta text-text-faint">
              <div class="min-w-0 flex items-center gap-2">
                <span
                  class="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={`background-color:${agentHexColor(result.session_agent)}`}
                ></span>
                <span class="truncate">{result.session_project || result.session_agent}</span>
                <span>·</span>
                <span class={result.message_role === 'user' ? 'text-accent' : 'text-ok'}>
                  {result.message_role}
                </span>
                <span>·</span>
                <span class="tabular font-mono">msg #{result.message_ordinal}</span>
              </div>
              <div class="shrink-0 tabular font-mono">
                {#if result.session_started_at}
                  {timeAgo(result.session_started_at)}
                {:else}
                  {result.session_id.slice(0, 8)}
                {/if}
              </div>
            </div>
            <div class="text-body text-text line-clamp-2">
              {@html sanitizeSnippet(result.snippet)}
            </div>
            {#if result.session_first_message}
              <div class="mt-2 truncate text-meta text-text-faint">
                {getSessionPreviewText(result.session_first_message)}
              </div>
            {/if}
          </button>
          </div>
        {/each}

        {#if search.loading && search.results.length === 0}
          <div class="py-16 text-center text-meta text-text-muted">Searching transcript history…</div>
        {:else if search.error}
          <div class="py-10 text-center text-meta text-danger">{search.error}</div>
        {:else if search.searched && !search.loading && search.results.length === 0}
          <EmptyState title={`No transcript matches found for "${search.query}".`} />
        {/if}

        {#if search.hasMore && !search.loading}
          <div class="py-3 text-center">
            <Button variant="ghost" size="sm" onclick={() => search.loadMore()}>Load more results</Button>
          </div>
        {/if}
      </div>
    {:else}
      <div class="space-y-2">
        {#each search.recentSessions as session (session.id)}
          <button
            class="w-full rounded-sm border border-line bg-surface px-3 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
            onclick={() => search.openSession(session.id)}
          >
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0 flex items-center gap-2">
                <span
                  class="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={`background-color:${agentHexColor(session.agent)}`}
                ></span>
                <span class="truncate text-body text-text">{sessionPreview(session)}</span>
              </div>
              <div class="flex shrink-0 items-center gap-3 text-meta text-text-faint">
                {#if session.project}
                  <span>{session.project}</span>
                {/if}
                <span class="tabular font-mono">{session.message_count} msgs</span>
                {#if session.started_at}
                  <span class="tabular font-mono">{timeAgo(session.started_at)}</span>
                {/if}
              </div>
            </div>
          </button>
        {/each}

        {#if search.recentLoading}
          <div class="py-16 text-center text-meta text-text-muted">Loading recent sessions…</div>
        {:else if search.recentError}
          <div class="py-10 text-center text-meta text-danger">{search.recentError}</div>
        {:else if search.recentSessions.length === 0}
          <EmptyState title="No sessions match the current filters." />
        {/if}
      </div>
    {/if}
  </div>
</main>
