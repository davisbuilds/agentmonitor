<script lang="ts">
  import { getQuotaMonitor } from '../../stores/monitor.svelte';
  import type { QuotaMonitorData, QuotaMonitorWindow } from '../../api/client';
  import { parseTimestamp, timeAgo } from '../../format';

  const data = $derived(getQuotaMonitor());
  const rows = $derived(data);

  function barColor(usedPercent: number): string {
    if (usedPercent >= 85) return 'bg-red-500';
    if (usedPercent >= 60) return 'bg-yellow-500';
    return 'bg-emerald-500';
  }

  function providerLabel(row: QuotaMonitorData): string {
    return row.provider === 'claude' ? 'Claude' : 'Codex';
  }

  function windowLabel(window: QuotaMonitorWindow): string {
    const minutes = window.window_minutes ?? 0;
    if (minutes === 300) return '5h';
    if (minutes === 10080) return '1w';
    if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }

  function resetLabel(value: string | null): string {
    if (!value) return 'reset unavailable';
    const resetAt = parseTimestamp(value);
    const msRemaining = resetAt.getTime() - Date.now();
    if (msRemaining <= 0) return 'resetting';
    if (msRemaining < 60 * 60 * 1000) return `resets in ${Math.ceil(msRemaining / 60000)}m`;
    if (msRemaining < 24 * 60 * 60 * 1000) return `resets ${resetAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()}`;
    return `resets ${resetAt.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  }

  function windows(row: QuotaMonitorData): QuotaMonitorWindow[] {
    return [row.primary, row.secondary].filter(Boolean) as QuotaMonitorWindow[];
  }

  function unavailableCopy(row: QuotaMonitorData): string {
    if (row.status === 'error') return row.error_message || 'quota unavailable';
    return row.provider === 'claude'
      ? 'statusline bridge needed'
      : 'native quota unavailable';
  }
</script>

{#if rows.length > 0}
  <div class="border-b border-gray-800 px-4 sm:px-6 py-2 bg-gray-900/50">
    <div class="flex items-center gap-x-6 gap-y-2 flex-wrap">
      {#each rows as row}
        <div class="flex items-center gap-3 text-xs min-w-0 flex-wrap">
          <span class="text-gray-400 shrink-0">{providerLabel(row)}</span>
          {#if row.status === 'available' && windows(row).length > 0}
            {#each windows(row) as window, index (index)}
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-gray-500 shrink-0">{windowLabel(window)}</span>
                <div
                  class="w-20 h-1.5 bg-gray-700 rounded-full overflow-hidden"
                  role="progressbar"
                  aria-label={`${providerLabel(row)} ${windowLabel(window)} quota usage`}
                  aria-valuenow={window.used_percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div class="h-full rounded-full {barColor(window.used_percent)}" style="width: {window.used_percent}%"></div>
                </div>
                <span class="text-gray-500 tabular-nums shrink-0">{Math.round(window.remaining_percent)}% left</span>
                <span class="text-gray-600 shrink-0">{resetLabel(window.resets_at)}</span>
              </div>
            {/each}
            {#if row.plan_type}
              <span class="text-gray-600 shrink-0 uppercase tracking-wide">{row.plan_type}</span>
            {/if}
            {#if row.updated_at}
              <span class="text-gray-700 shrink-0">updated {timeAgo(row.updated_at)}</span>
            {/if}
          {:else}
            <span class="text-gray-600 shrink-0">{unavailableCopy(row)}</span>
            {#if row.updated_at}
              <span class="text-gray-700 shrink-0">last update {timeAgo(row.updated_at)}</span>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}
