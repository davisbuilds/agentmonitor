<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';

  const maxCount = $derived(Math.max(...analytics.toolUsage.map((tool) => tool.count), 1));
</script>

<section class="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold text-gray-200">Tool Usage</h3>
      <p class="text-xs text-gray-500">This panel only counts sessions with tool-analytics coverage.</p>
    </div>
    {#if analytics.coverage.tools}
      <span class="text-xs text-amber-300">{analytics.coverage.tools.included_sessions}/{analytics.coverage.tools.matching_sessions} sessions included</span>
    {/if}
  </div>

  {#if analytics.coverage.tools && analytics.coverage.tools.excluded_sessions > 0}
    <div class="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      {analytics.coverage.tools.excluded_sessions} summary-only session{analytics.coverage.tools.excluded_sessions === 1 ? '' : 's'} excluded from tool analytics.
    </div>
  {/if}

  {#if analytics.loading.tools}
    <div class="py-12 text-center text-sm text-gray-500">Loading tool usage...</div>
  {:else if analytics.errors.tools}
    <div class="py-12 text-center text-sm text-red-300">{analytics.errors.tools}</div>
  {:else if analytics.toolUsage.length > 0}
    <div class="space-y-2">
      {#each analytics.toolUsage.slice(0, 12) as tool}
        <div>
          <div class="mb-1 flex items-center justify-between gap-2 text-xs">
            <span class="truncate font-mono text-gray-300">{tool.tool_name}</span>
            <span class="text-gray-500">{formatNumber(tool.count)}</span>
          </div>
          <div class="h-2 rounded-full bg-gray-800">
            <div class="h-2 rounded-full bg-amber-500/70" style={`width:${(tool.count / maxCount) * 100}%`}></div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="py-12 text-center text-sm text-gray-500">No tool usage for the selected range.</div>
  {/if}
</section>
