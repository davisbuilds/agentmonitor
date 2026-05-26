<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';

  const maxCount = $derived(Math.max(...analytics.toolUsage.map((tool) => tool.count), 1));
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-h3">Tool Usage</h3>
      <p class="mt-0.5 text-meta text-text-muted">This panel only counts sessions with tool-analytics coverage.</p>
    </div>
    {#if analytics.coverage.tools}
      <span class="tabular font-mono text-meta text-text-faint">{analytics.coverage.tools.included_sessions}/{analytics.coverage.tools.matching_sessions} sessions included</span>
    {/if}
  </div>

  {#if analytics.coverage.tools && analytics.coverage.tools.excluded_sessions > 0}
    <div class="mb-3 flex items-start gap-2 text-meta text-text-muted">
      <span class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true"></span>
      <p>{analytics.coverage.tools.excluded_sessions} summary-only session{analytics.coverage.tools.excluded_sessions === 1 ? '' : 's'} excluded from tool analytics.</p>
    </div>
  {/if}

  {#if analytics.loading.tools}
    <div class="py-12 text-center text-meta text-text-muted">Loading tool usage…</div>
  {:else if analytics.errors.tools}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.tools}</div>
  {:else if analytics.toolUsage.length > 0}
    <div class="space-y-2.5">
      {#each analytics.toolUsage.slice(0, 12) as tool}
        <div>
          <div class="mb-1 flex items-center justify-between gap-2 text-meta">
            <span class="truncate font-mono text-text">{tool.tool_name}</span>
            <span class="tabular font-mono text-text-faint">{formatNumber(tool.count)}</span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-sm bg-surface-2">
            <div class="h-full rounded-sm bg-accent/70" style={`width:${(tool.count / maxCount) * 100}%`}></div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No tool usage for the selected range.</div>
  {/if}
</section>
