<script lang="ts">
  import { getUsageMonitor } from '../../stores/monitor.svelte';
  import type { UsageMonitorData } from '../../api/client';
  import { formatCost, formatNumber } from '../../format';

  const data = $derived(getUsageMonitor());
  const agents = $derived(
    data.filter((agent) => agent.session.limit > 0 || (agent.extended?.limit || 0) > 0 || (agent.weekly?.limit || 0) > 0)
  );
  const hasData = $derived(agents.length > 0);

  function barColor(percent: number): string {
    if (percent >= 85) return 'bg-red-500';
    if (percent >= 60) return 'bg-yellow-500';
    return 'bg-emerald-500';
  }

  function agentLabel(agentType: string): string {
    switch (agentType) {
      case 'claude_code':
        return 'Claude';
      case 'codex':
        return 'Codex';
      default:
        return agentType;
    }
  }

  function formatUsage(value: number, limitType: UsageMonitorData['limitType']): string {
    return limitType === 'cost' ? formatCost(value) : formatNumber(value);
  }

  function formatWindowLabel(hours: number): string {
    if (hours >= 168 && hours % 168 === 0) return `${hours / 168}w`;
    if (hours >= 24 && hours % 24 === 0) return `${hours / 24}d`;
    return `${hours}h`;
  }

  function percent(used: number, limit: number): number {
    if (limit <= 0) return 0;
    return Math.min((used / limit) * 100, 100);
  }

  function usageWindows(agent: UsageMonitorData): Array<{
    key: string;
    used: number;
    limit: number;
    windowHours: number;
  }> {
    return [
      { key: 'session', ...agent.session },
      ...(agent.extended ? [{ key: 'extended', ...agent.extended }] : []),
      ...(agent.weekly ? [{ key: 'weekly', ...agent.weekly }] : []),
    ].filter((window) => window.limit > 0);
  }
</script>

{#if hasData}
  <div class="border-b border-gray-800 px-4 sm:px-6 py-2 bg-gray-900/50">
    <div class="flex items-center gap-x-6 gap-y-2 flex-wrap">
      {#each agents as agent}
        <div class="flex items-center gap-3 text-xs min-w-0 flex-wrap">
          <span class="text-gray-400 shrink-0">{agentLabel(agent.agent_type)}</span>
          {#each usageWindows(agent) as window (window.key)}
            {@const usagePercent = percent(window.used, window.limit)}
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-gray-500 shrink-0">{formatWindowLabel(window.windowHours)}</span>
              <div
                class="w-20 h-1.5 bg-gray-700 rounded-full overflow-hidden"
                role="progressbar"
                aria-label={`${agentLabel(agent.agent_type)} ${formatWindowLabel(window.windowHours)} usage`}
                aria-valuenow={usagePercent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div class="h-full rounded-full {barColor(usagePercent)}" style="width: {usagePercent}%"></div>
              </div>
              <span class="text-gray-500 tabular-nums shrink-0">
                {formatUsage(window.used, agent.limitType)}/{formatUsage(window.limit, agent.limitType)}
              </span>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
{/if}
