<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';

  const maxMessages = $derived(Math.max(...analytics.projectBreakdowns.map((project) => project.message_count), 1));
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-h3">Projects</h3>
      <p class="mt-0.5 text-meta text-text-muted">Click a project to drill the whole page into that slice.</p>
    </div>
    {#if analytics.project}
      <span class="text-meta text-accent">Filtered to {analytics.project}</span>
    {/if}
  </div>

  {#if analytics.loading.projects}
    <div class="py-12 text-center text-meta text-text-muted">Loading projects…</div>
  {:else if analytics.errors.projects}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.projects}</div>
  {:else if analytics.projectBreakdowns.length > 0}
    <div class="space-y-2.5">
      {#each analytics.projectBreakdowns.slice(0, 10) as project}
        <button class="block w-full text-left" onclick={() => analytics.drillDownToProject(project.project)}>
          <div class="mb-1 flex items-center justify-between gap-2 text-meta">
            <span class="truncate text-text">{project.project}</span>
            <span class="tabular font-mono text-text-faint">{project.session_count} sessions · {formatNumber(project.message_count)} msgs</span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-sm bg-surface-2">
            <div class="h-full rounded-sm bg-accent/70" style={`width:${(project.message_count / maxMessages) * 100}%`}></div>
          </div>
        </button>
      {/each}
    </div>
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No project data in the selected range.</div>
  {/if}
</section>
