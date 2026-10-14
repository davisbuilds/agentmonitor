<script lang="ts">
  import type { SearchResult } from '../../api/client';
  import { agentHexColor, timeAgo } from '../../format';
  import { sessionTitle } from '../../session-text';
  import type { SearchStore } from '../../stores/search.svelte';
  import { Button, EmptyState } from '../ui';
  import TraceDrillInLink from '../trace-quality/TraceDrillInLink.svelte';

  interface Props {
    search: SearchStore;
    onopen: (result: SearchResult) => void;
  }

  let { search, onopen }: Props = $props();

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

  function resultSessionTitle(result: SearchResult): string {
    return sessionTitle({ title: result.session_title, first_message: result.session_first_message, agent: result.session_agent });
  }
</script>

<div class="space-y-2">
  {#each search.results as result (result.message_id)}
    <div class="relative">
      <TraceDrillInLink sessionId={result.session_id} class="absolute right-2 bottom-2 z-10 bg-surface" />
      <button
        class="w-full rounded-sm border border-line bg-surface px-3 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
        onclick={() => onopen(result)}
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
            {/if}
          </div>
        </div>
        <div class="text-body text-text line-clamp-2">
          {@html sanitizeSnippet(result.snippet)}
        </div>
        <div class="mt-2 truncate text-meta text-text-faint">{resultSessionTitle(result)}</div>
      </button>
    </div>
  {/each}

  {#if search.loading && search.results.length === 0}
    <div class="py-16 text-center text-meta text-text-muted">Searching transcript history…</div>
  {:else if search.error}
    <div class="py-10 text-center text-meta text-danger">{search.error}</div>
  {:else if search.searched && !search.loading && search.results.length === 0}
    <EmptyState title={`No transcript matches found for "${search.query.trim()}".`} />
  {/if}

  {#if search.hasMore && !search.loading}
    <div class="py-3 text-center">
      <Button variant="ghost" size="sm" onclick={() => search.loadMore()}>Load more results</Button>
    </div>
  {/if}
</div>
