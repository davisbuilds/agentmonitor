<script lang="ts">
  import { getCostData } from '../../stores/monitor.svelte';
  import { formatCost } from '../../format';

  const costData = $derived(getCostData());

  const totalCost = $derived.by(() => {
    if (!costData) return 0;
    return costData.by_model.reduce((sum, m) => sum + m.cost, 0);
  });
</script>

<div class="flex items-center justify-between mb-3">
  <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">Cost Overview</h2>
</div>

{#if costData}
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <!-- Total -->
    <div class="bg-gray-900 rounded-lg border border-gray-700 p-4">
      <div class="text-xs text-gray-400 uppercase mb-1">Total Cost</div>
      <div class="text-2xl font-bold text-white">{formatCost(totalCost)}</div>
    </div>

    <!-- By Model -->
    <div class="bg-gray-900 rounded-lg border border-gray-700 p-4">
      <div class="text-xs text-gray-400 uppercase mb-2">By Model</div>
      {#if costData.by_model.length > 0}
        <div class="space-y-1">
          {#each costData.by_model.slice(0, 5) as item}
            <div class="flex justify-between text-xs">
              <span class="text-gray-300 truncate mr-2">{item.model}</span>
              <span class="text-white font-medium shrink-0">{formatCost(item.cost)}</span>
            </div>
          {/each}
        </div>
      {:else}
        <div class="text-xs text-gray-500">No data</div>
      {/if}
    </div>

    <!-- By Project -->
    <div class="bg-gray-900 rounded-lg border border-gray-700 p-4">
      <div class="text-xs text-gray-400 uppercase mb-2">By Project</div>
      {#if costData.by_project.length > 0}
        <div class="space-y-1">
          {#each costData.by_project.slice(0, 5) as item}
            <div class="flex justify-between text-xs">
              <span class="text-gray-300 truncate mr-2">{item.project}</span>
              <span class="text-white font-medium shrink-0">{formatCost(item.cost)}</span>
            </div>
          {/each}
        </div>
      {:else}
        <div class="text-xs text-gray-500">No data</div>
      {/if}
    </div>
  </div>
{:else}
  <div class="bg-gray-900 rounded-lg border border-gray-700 p-4 text-center text-gray-500 text-sm">
    Loading cost data...
  </div>
{/if}
