<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { timeAgo } from '../../format';

  function preview(session: { id: string; project: string | null; message_count: number }) {
    return session.project ? `${session.project}` : session.id.slice(0, 12);
  }
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-h3">Top Sessions</h3>
      <p class="mt-0.5 text-meta text-text-muted">Highest-volume sessions in the current filter set.</p>
    </div>
    {#if analytics.coverage.topSessions}
      <span class="tabular font-mono text-meta text-text-faint">{analytics.coverage.topSessions.included_sessions} sessions scanned</span>
    {/if}
  </div>

  {#if analytics.loading.topSessions}
    <div class="py-12 text-center text-meta text-text-muted">Loading top sessions…</div>
  {:else if analytics.errors.topSessions}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.topSessions}</div>
  {:else if analytics.topSessions.length > 0}
    <div class="divide-y divide-line/60">
      {#each analytics.topSessions as session, index}
        <button
          class="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors hover:bg-surface-2"
          onclick={() => analytics.openSession(session.id)}
        >
          <div class="w-6 text-right tabular font-mono text-meta text-text-faint">{index + 1}</div>
          <div class="min-w-0 flex-1">
            <div class="truncate text-body text-text">{preview(session)}</div>
            <div class="text-meta text-text-faint">{session.agent} · {session.tool_call_count} tool calls</div>
          </div>
          <div class="text-right tabular font-mono text-meta text-text-muted">
            <div>{session.message_count} msgs</div>
            {#if session.started_at}
              <div class="text-text-faint">{timeAgo(session.started_at)}</div>
            {/if}
          </div>
        </button>
      {/each}
    </div>
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No sessions in the selected range.</div>
  {/if}
</section>
