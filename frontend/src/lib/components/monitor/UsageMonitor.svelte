<script lang="ts">
  import { getUsageMonitor } from '../../stores/monitor.svelte';
  import { formatNumber } from '../../format';

  const data = $derived(getUsageMonitor());
  const hasData = $derived(data.length > 0);

  function barColor(percent: number): string {
    if (percent >= 90) return 'bg-red-500';
    if (percent >= 70) return 'bg-yellow-500';
    return 'bg-green-500';
  }
</script>

{#if hasData}
  <div class="border-b border-gray-800 px-4 sm:px-6 py-2 bg-gray-900/50">
    <div class="flex items-center gap-4 flex-wrap">
      {#each data as agent}
        <div class="flex items-center gap-2 text-xs">
          <span class="text-gray-400">{agent.agent_type}</span>
          {#if agent.session.limit > 0}
            <div class="flex items-center gap-1">
              <span class="text-gray-500">S:</span>
              <div class="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div class="h-full rounded-full {barColor(agent.session.percent)}" style="width: {Math.min(agent.session.percent, 100)}%"></div>
              </div>
              <span class="text-gray-500">{formatNumber(agent.session.tokens)}</span>
            </div>
          {/if}
          {#if agent.weekly.limit > 0}
            <div class="flex items-center gap-1">
              <span class="text-gray-500">W:</span>
              <div class="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div class="h-full rounded-full {barColor(agent.weekly.percent)}" style="width: {Math.min(agent.weekly.percent, 100)}%"></div>
              </div>
              <span class="text-gray-500">{formatNumber(agent.weekly.tokens)}</span>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}
