<script lang="ts">
  import { getToolStats } from '../../stores/monitor.svelte';
  import { formatDuration } from '../../format';

  const toolStats = $derived(getToolStats());
  const tools = $derived(toolStats?.tools || []);
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
            <th class="text-right py-2 px-2">Errors</th>
            <th class="text-right py-2 px-2">Error %</th>
            <th class="text-right py-2 pl-2">Avg Duration</th>
          </tr>
        </thead>
        <tbody>
          {#each tools.slice(0, 15) as tool}
            <tr class="border-b border-gray-800/50 hover:bg-gray-800/30">
              <td class="py-1.5 pr-4 text-gray-300">{tool.tool_name}</td>
              <td class="py-1.5 px-2 text-right text-white">{tool.total_calls}</td>
              <td class="py-1.5 px-2 text-right {tool.error_count > 0 ? 'text-red-400' : 'text-gray-500'}">{tool.error_count}</td>
              <td class="py-1.5 px-2 text-right {tool.error_rate > 10 ? 'text-red-400' : 'text-gray-500'}">{tool.error_rate.toFixed(1)}%</td>
              <td class="py-1.5 pl-2 text-right text-gray-400">{formatDuration(tool.avg_duration_ms)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
