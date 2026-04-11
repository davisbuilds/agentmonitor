<script lang="ts">
  import { getToolStats } from '../../stores/monitor.svelte';
  import { formatDuration, formatNumber } from '../../format';

  const toolStats = $derived(getToolStats());
  const tools = $derived(toolStats?.tools || []);
  const maxCalls = $derived.by(() => Math.max(...tools.map((tool) => tool.total_calls), 1));

  function errorTextClass(errorRate: number): string {
    if (errorRate > 0.1) return 'text-red-400';
    if (errorRate > 0) return 'text-yellow-400';
    return 'text-gray-500';
  }
</script>

<div class="flex items-center justify-between mb-3">
  <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">Tool Analytics</h2>
</div>

<div class="bg-gray-900 rounded-lg border border-gray-700 p-4">
  {#if tools.length === 0}
    <div class="text-center text-gray-500 text-sm">No tool usage data</div>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead>
          <tr class="text-gray-400 border-b border-gray-700">
            <th class="text-left py-2 pr-4">Tool</th>
            <th class="text-right py-2 px-2">Calls</th>
            <th class="py-2 px-2 w-1/3">Frequency</th>
            <th class="text-right py-2 px-2">Errors</th>
            <th class="text-right py-2 px-2">Error %</th>
            <th class="text-right py-2 pl-2">Avg Duration</th>
          </tr>
        </thead>
        <tbody>
          {#each tools.slice(0, 15) as tool}
            {@const frequencyPercent = Math.max(2, (tool.total_calls / maxCalls) * 100)}
            <tr class="border-b border-gray-800/50 hover:bg-gray-800/30">
              <td class="py-1.5 pr-4 text-gray-300">{tool.tool_name}</td>
              <td class="py-1.5 px-2 text-right text-white">{formatNumber(tool.total_calls)}</td>
              <td class="py-1.5 px-2">
                <div
                  class="h-1.5 rounded-full bg-gray-800 overflow-hidden"
                  role="progressbar"
                  aria-label={`${tool.tool_name} frequency`}
                  aria-valuenow={frequencyPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div class="h-full rounded-full bg-emerald-500" style={`width: ${frequencyPercent}%`}></div>
                </div>
              </td>
              <td class="py-1.5 px-2 text-right {errorTextClass(tool.error_rate)}">{tool.error_count}</td>
              <td class="py-1.5 px-2 text-right {errorTextClass(tool.error_rate)}">{(tool.error_rate * 100).toFixed(1)}%</td>
              <td class="py-1.5 pl-2 text-right text-gray-400">{formatDuration(tool.avg_duration_ms)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
