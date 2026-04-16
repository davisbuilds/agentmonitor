<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatNumber } from '../../format';

  function openSession(sessionId: string, available: boolean): void {
    if (!available) return;
    usage.openSession(sessionId);
  }
</script>

<section class="rounded-xl border border-gray-800 bg-gray-950/60 p-4">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h2 class="text-sm font-semibold text-white">Top Sessions</h2>
      <p class="mt-1 text-xs text-gray-500">Highest-cost sessions in the selected window. Sessions without transcript history stay visible as event-only rows.</p>
    </div>
  </div>

  {#if usage.loading.topSessions}
    <div class="mt-4 space-y-3">
      {#each Array.from({ length: 5 }) as _}
        <div class="h-14 animate-pulse rounded-lg bg-gray-900"></div>
      {/each}
    </div>
  {:else if usage.errors.topSessions}
    <div class="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
      {usage.errors.topSessions}
    </div>
  {:else if usage.topSessions.length === 0}
    <div class="mt-4 rounded-lg border border-dashed border-gray-800 px-4 py-10 text-center text-sm text-gray-500">
      No usage-bearing sessions in this range.
    </div>
  {:else}
    <div class="mt-4 space-y-2">
      {#each usage.topSessions as row}
        <div class="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-sm font-medium text-white">{row.id}</div>
              <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                <span>{row.project ?? 'unknown project'}</span>
                <span>{row.agent}</span>
                <span>{formatNumber(row.usage_events)} usage events</span>
                <span>{formatNumber(row.input_tokens + row.output_tokens)} tokens</span>
              </div>
            </div>
            <div class="text-right">
              <div class="text-sm font-medium text-emerald-300">{formatCost(row.cost_usd)}</div>
              <div class="mt-1 text-xs text-gray-500">
                {row.last_activity_at ? row.last_activity_at.slice(0, 10) : 'No timestamp'}
              </div>
            </div>
          </div>

          <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap gap-2 text-xs">
              <span class="rounded-full border border-gray-700 px-2 py-1 text-gray-300">
                {formatNumber(row.event_count)} total events
              </span>
              {#if row.message_count != null}
                <span class="rounded-full border border-gray-700 px-2 py-1 text-gray-300">
                  {formatNumber(row.message_count)} messages
                </span>
              {/if}
              {#if row.fidelity}
                <span class="rounded-full border border-gray-700 px-2 py-1 text-gray-300">
                  {row.fidelity}
                </span>
              {/if}
            </div>

            <button
              class="rounded border px-3 py-1.5 text-xs transition {row.browsing_session_available ? 'border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white' : 'border-gray-800 text-gray-600 cursor-not-allowed'}"
              disabled={!row.browsing_session_available}
              onclick={() => openSession(row.id, row.browsing_session_available)}
            >
              {row.browsing_session_available ? 'Open Session' : 'Events Only'}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>
