<script lang="ts">
  import { getCostData } from '../../stores/monitor.svelte';
  import { getCostWindow, setCostWindow } from '../../stores/monitor.svelte';
  import { COST_WINDOW_OPTIONS, formatMonitorCost, shortModelName, type CostWindow } from '../../monitor-analytics';

  interface Props {
    onwindowchange: () => void;
  }

  let { onwindowchange }: Props = $props();

  const costData = $derived(getCostData());
  const costWindow = $derived(getCostWindow());

  const totalCost = $derived.by(() => {
    if (!costData) return 0;
    return costData.by_model.reduce((sum, m) => sum + m.cost, 0);
  });
  const maxModelCost = $derived.by(() => Math.max(...(costData?.by_model || []).map((item) => item.cost), 0.01));
  const maxProjectCost = $derived.by(() => Math.max(...(costData?.by_project || []).map((item) => item.cost), 0.01));
  const maxTimelineCost = $derived.by(() => Math.max(...(costData?.timeline || []).map((item) => item.cost), 0.001));
  const timelinePoints = $derived.by(() => {
    if (!costData || costData.timeline.length < 2) return '';
    return costData.timeline
      .map((bucket, index) => {
        const x = (index / Math.max(costData.timeline.length - 1, 1)) * 100;
        const y = 100 - ((bucket.cost / maxTimelineCost) * 100);
        return `${x},${y}`;
      })
      .join(' ');
  });

  function handleWindowChange(nextWindow: CostWindow): void {
    if (nextWindow === costWindow) return;
    setCostWindow(nextWindow);
    onwindowchange();
  }
</script>

<div class="flex items-center justify-between mb-3">
  <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">Cost Overview</h2>
  <div class="flex items-center gap-1 rounded-lg border border-gray-800 bg-gray-900/60 p-1 text-[11px]">
    {#each COST_WINDOW_OPTIONS as option (option.value)}
      <button
        class={`rounded px-2 py-1 transition-colors ${costWindow === option.value ? 'bg-gray-700 text-gray-100' : 'text-gray-500 hover:text-gray-300'}`}
        onclick={() => handleWindowChange(option.value)}
      >
        {option.label}
      </button>
    {/each}
  </div>
</div>

{#if costData}
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <!-- Total -->
    <div class="bg-gray-900 rounded-lg border border-gray-700 p-4">
      <div class="text-xs text-gray-400 uppercase mb-1">Total Cost</div>
      <div class="text-2xl font-bold text-white">{formatMonitorCost(totalCost)}</div>
      <div class="mt-1 text-xs text-gray-500">Rolling window: {costWindow === 'all' ? 'all time' : costWindow}</div>
    </div>

    <!-- By Model -->
    <div class="bg-gray-900 rounded-lg border border-gray-700 p-4">
      <div class="text-xs text-gray-400 uppercase mb-2">By Model</div>
      {#if costData.by_model.length > 0}
        <div class="space-y-1">
          {#each costData.by_model.slice(0, 5) as item}
            <div>
              <div class="flex justify-between text-xs">
                <span class="text-gray-300 truncate mr-2">{shortModelName(item.model)}</span>
                <span class="text-white font-medium shrink-0">{formatMonitorCost(item.cost)}</span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                <div class="h-full rounded-full bg-blue-500/70" style={`width: ${Math.max(2, (item.cost / maxModelCost) * 100)}%`}></div>
              </div>
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
            <div>
              <div class="flex justify-between text-xs">
                <span class="text-gray-300 truncate mr-2">{item.project}</span>
                <span class="text-white font-medium shrink-0">{formatMonitorCost(item.cost)}</span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                <div class="h-full rounded-full bg-violet-500/70" style={`width: ${Math.max(2, (item.cost / maxProjectCost) * 100)}%`}></div>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="text-xs text-gray-500">No data</div>
      {/if}
    </div>
  </div>

  {#if costData.timeline.length > 1}
    <div class="mt-4 rounded-lg border border-gray-700 bg-gray-900 p-4">
      <div class="mb-3 flex items-center justify-between">
        <div class="text-xs text-gray-400 uppercase">Spend Over Time</div>
        <div class="text-xs text-gray-500">
          {costData.timeline[0]?.date} to {costData.timeline[costData.timeline.length - 1]?.date}
        </div>
      </div>
      <svg viewBox="0 0 100 100" class="h-28 w-full overflow-visible">
        <polyline
          fill="none"
          stroke="rgb(96 165 250)"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
          points={timelinePoints}
        />
      </svg>
    </div>
  {/if}
{:else}
  <div class="bg-gray-900 rounded-lg border border-gray-700 p-4 text-center text-gray-500 text-sm">
    Loading cost data...
  </div>
{/if}
