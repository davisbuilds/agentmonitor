<script lang="ts">
  import { getToolStats } from '../../stores/monitor.svelte';
  import { formatDuration, formatNumber } from '../../format';
  import { Panel, DataTable, Bar } from '../ui';

  const toolStats = $derived(getToolStats());
  const tools = $derived((toolStats?.tools || []).slice(0, 15));
  const maxCalls = $derived.by(() => Math.max(...tools.map((tool) => tool.total_calls), 1));

  function errorTextClass(errorRate: number): string {
    if (errorRate > 0.1) return 'text-danger';
    if (errorRate > 0) return 'text-warn';
    return 'text-text-faint';
  }

  const columns = [
    { key: 'tool_name', label: 'Tool' },
    { key: 'total_calls', label: 'Calls', numeric: true },
    { key: 'frequency', label: 'Frequency', width: '30%' },
    { key: 'error_count', label: 'Errors', numeric: true },
    { key: 'error_rate', label: 'Error %', numeric: true },
    { key: 'avg_duration_ms', label: 'Avg Duration', numeric: true },
  ];
</script>

<Panel title="Tool Analytics" padded={false}>
  <DataTable {columns} rows={tools} rowKey={(tool) => tool.tool_name} empty="No tool usage data">
    {#snippet cell(tool, column)}
      {#if column.key === 'tool_name'}
        <span class="text-text">{tool.tool_name}</span>
      {:else if column.key === 'total_calls'}
        {formatNumber(tool.total_calls)}
      {:else if column.key === 'frequency'}
        <Bar value={tool.total_calls} max={maxCalls} tone="accent" />
      {:else if column.key === 'error_count'}
        <span class={errorTextClass(tool.error_rate)}>{tool.error_count}</span>
      {:else if column.key === 'error_rate'}
        <span class={errorTextClass(tool.error_rate)}>{(tool.error_rate * 100).toFixed(1)}%</span>
      {:else if column.key === 'avg_duration_ms'}
        <span class="text-text-muted">{formatDuration(tool.avg_duration_ms)}</span>
      {/if}
    {/snippet}
  </DataTable>
</Panel>
