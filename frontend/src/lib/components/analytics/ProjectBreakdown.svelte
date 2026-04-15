<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';

  const maxMessages = $derived(Math.max(...analytics.projectBreakdowns.map((project) => project.message_count), 1));
</script>

<section class="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold text-gray-200">Projects</h3>
      <p class="text-xs text-gray-500">Click a project to drill the whole page into that slice.</p>
    </div>
    {#if analytics.project}
      <span class="text-xs text-emerald-300">Filtered to {analytics.project}</span>
    {/if}
  </div>

  {#if analytics.loading.projects}
    <div class="py-12 text-center text-sm text-gray-500">Loading projects...</div>
  {:else if analytics.errors.projects}
    <div class="py-12 text-center text-sm text-red-300">{analytics.errors.projects}</div>
  {:else if analytics.projectBreakdowns.length > 0}
    <div class="space-y-2">
      {#each analytics.projectBreakdowns.slice(0, 10) as project}
        <button class="block w-full text-left" onclick={() => analytics.drillDownToProject(project.project)}>
          <div class="mb-1 flex items-center justify-between gap-2 text-xs">
            <span class="truncate text-gray-300">{project.project}</span>
            <span class="text-gray-500">{project.session_count} sessions · {formatNumber(project.message_count)} msgs</span>
          </div>
          <div class="h-2 rounded-full bg-gray-800">
            <div class="h-2 rounded-full bg-emerald-500/70" style={`width:${(project.message_count / maxMessages) * 100}%`}></div>
          </div>
        </button>
      {/each}
    </div>
  {:else}
    <div class="py-12 text-center text-sm text-gray-500">No project data in the selected range.</div>
  {/if}
</section>
