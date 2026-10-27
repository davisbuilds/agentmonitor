<script lang="ts">
  import type { AgentEvent } from '../../api/client';
  import { formatDuration, timeAgo } from '../../format';
  import { sessionEventDetail, sessionEventLabel } from '../../monitor-session-view';

  interface Props {
    /** Newest first (`sessionRecentEvents`). */
    events: AgentEvent[];
    loading: boolean;
    error: string | null;
  }

  let { events, loading, error }: Props = $props();

  function dotClass(event: AgentEvent): string {
    if (event.status === 'error') return 'bg-danger';
    if (event.event_type === 'tool_use') return 'bg-accent';
    return 'bg-line-strong';
  }
</script>

{#if loading && events.length === 0}
  <div class="py-8 text-center text-meta text-text-muted">Loading events…</div>
{:else if error && events.length === 0}
  <div class="py-8 text-center text-meta text-danger">{error}</div>
{:else if events.length === 0}
  <div class="py-8 text-center text-meta text-text-muted">No events recorded for this session.</div>
{:else}
  <ul class="space-y-1" aria-label="Recent events">
    {#each events as event (event.id)}
      {@const detail = sessionEventDetail(event)}
      <li class="rounded-sm px-2 py-1.5 text-meta">
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 shrink-0 rounded-full {dotClass(event)}" aria-hidden="true"></span>
          <span class="min-w-0 truncate font-mono text-text">{sessionEventLabel(event)}</span>
          {#if event.status === 'error'}<span class="shrink-0 text-danger">error</span>{/if}
          <span class="flex-1"></span>
          {#if event.duration_ms != null}
            <span class="shrink-0 tabular font-mono text-text-faint" title="Duration">{formatDuration(event.duration_ms)}</span>
          {/if}
          <span class="shrink-0 tabular font-mono text-text-faint">{timeAgo(event.created_at)}</span>
        </div>
        {#if detail}
          <p class="mt-0.5 truncate pl-3.5 text-text-muted" title={detail}>{detail}</p>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
