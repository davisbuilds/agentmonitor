<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { timeAgo } from '../../format';

  function preview(session: { id: string; project: string | null; message_count: number }) {
    return session.project ? `${session.project}` : session.id.slice(0, 12);
  }
</script>

<section class="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold text-gray-200">Top Sessions</h3>
      <p class="text-xs text-gray-500">Highest-volume sessions in the current filter set.</p>
    </div>
    {#if analytics.coverage.topSessions}
      <span class="text-xs text-gray-500">{analytics.coverage.topSessions.included_sessions} sessions scanned</span>
    {/if}
  </div>

  {#if analytics.loading.topSessions}
    <div class="py-12 text-center text-sm text-gray-500">Loading top sessions...</div>
  {:else if analytics.errors.topSessions}
    <div class="py-12 text-center text-sm text-red-300">{analytics.errors.topSessions}</div>
  {:else if analytics.topSessions.length > 0}
    <div class="space-y-2">
      {#each analytics.topSessions as session, index}
        <button
          class="flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left hover:border-gray-700 hover:bg-gray-800/50"
          onclick={() => analytics.openSession(session.id)}
        >
          <div class="w-6 text-right text-xs font-semibold text-gray-500">{index + 1}</div>
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm text-gray-200">{preview(session)}</div>
            <div class="text-xs text-gray-500">{session.agent} · {session.tool_call_count} tool calls</div>
          </div>
          <div class="text-right text-xs text-gray-400">
            <div>{session.message_count} msgs</div>
            {#if session.started_at}
              <div>{timeAgo(session.started_at)}</div>
            {/if}
          </div>
        </button>
      {/each}
    </div>
  {:else}
    <div class="py-12 text-center text-sm text-gray-500">No sessions in the selected range.</div>
  {/if}
</section>
