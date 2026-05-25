<script lang="ts">
  import { getQuotaMonitor } from '../../stores/monitor.svelte';
  import type { QuotaMonitorData, QuotaMonitorWindow } from '../../api/client';
  import { parseTimestamp, timeAgo } from '../../format';

  const rows = $derived(getQuotaMonitor());
  let open = $state(false);
  let root = $state<HTMLDivElement>();

  function barColor(usedPercent: number): string {
    if (usedPercent >= 85) return 'bg-danger';
    if (usedPercent >= 60) return 'bg-warn';
    return 'bg-ok';
  }

  function dotColor(usedPercent: number): string {
    if (usedPercent >= 85) return 'bg-danger';
    if (usedPercent >= 60) return 'bg-warn';
    return 'bg-ok';
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
    return row.provider === 'claude' ? 'statusline bridge needed' : 'native quota unavailable';
  }

  // Most-constrained window per provider drives the compact pill.
  function worstWindow(row: QuotaMonitorData): QuotaMonitorWindow | null {
    const ws = windows(row);
    if (ws.length === 0) return null;
    return ws.reduce((worst, w) => (w.used_percent > worst.used_percent ? w : worst));
  }

  const available = $derived(rows.filter((r) => r.status === 'available' && windows(r).length > 0));

  function toggle() {
    open = !open;
  }

  function handleWindowClick(event: MouseEvent) {
    if (root && !root.contains(event.target as Node)) open = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') open = false;
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleKeydown} />

{#if rows.length > 0}
  <div class="relative" bind:this={root}>
    <button
      type="button"
      class="flex items-center gap-2 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-meta text-text-muted transition-colors hover:border-line-strong hover:text-text"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="Provider quota usage"
      onclick={toggle}
    >
      {#if available.length > 0}
        {#each available as row (row.provider)}
          {@const worst = worstWindow(row)}
          {#if worst}
            <span class="flex items-center gap-1.5">
              <span class="h-1.5 w-1.5 rounded-full {dotColor(worst.used_percent)}"></span>
              <span class="tabular font-mono text-text">{Math.round(worst.remaining_percent)}%</span>
            </span>
          {/if}
        {/each}
      {:else}
        <span class="h-1.5 w-1.5 rounded-full bg-line-strong"></span>
        <span>Quota</span>
      {/if}
      <svg class="h-3 w-3 text-text-faint" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    {#if open}
      <div
        class="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-line bg-surface p-3 shadow-overlay"
        role="dialog"
        aria-label="Provider quota detail"
      >
        <div class="space-y-3">
          {#each rows as row (row.provider)}
            <div class="space-y-1.5">
              <div class="flex items-center justify-between">
                <span class="text-meta font-medium text-text">{providerLabel(row)}</span>
                {#if row.plan_type}
                  <span class="text-meta uppercase tracking-wide text-text-faint">{row.plan_type}</span>
                {/if}
              </div>

              {#if row.status === 'available' && windows(row).length > 0}
                {#each windows(row) as window, index (index)}
                  <div class="flex items-center gap-2.5 text-meta">
                    <span class="w-6 shrink-0 text-text-faint">{windowLabel(window)}</span>
                    <div
                      class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
                      role="progressbar"
                      aria-label={`${providerLabel(row)} ${windowLabel(window)} quota usage`}
                      aria-valuenow={window.used_percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div class="h-full rounded-full {barColor(window.used_percent)}" style="width: {window.used_percent}%"></div>
                    </div>
                    <span class="tabular w-10 shrink-0 text-right font-mono text-text-muted">{Math.round(window.remaining_percent)}%</span>
                    <span class="w-24 shrink-0 text-right text-text-faint">{resetLabel(window.resets_at)}</span>
                  </div>
                {/each}
              {:else}
                <p class="text-meta text-text-faint">{unavailableCopy(row)}</p>
              {/if}

              {#if row.updated_at}
                <p class="text-meta text-text-faint">updated {timeAgo(row.updated_at)}</p>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}
