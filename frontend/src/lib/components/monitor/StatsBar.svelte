<script lang="ts">
  import { getStats } from '../../stores/monitor.svelte';
  import { formatCost, formatNumber } from '../../format';
  import { agentTokenRows, statsTotalTokens } from '../../monitor-token-totals';
  import { Popover } from '../ui';

  const stats = $derived(getStats());
  const sessionCount = $derived(Number.isFinite(stats.live_sessions) ? stats.live_sessions : stats.active_sessions);
  const agentCount = $derived(Number.isFinite(stats.active_agents) ? stats.active_agents : Object.keys(stats.agent_breakdown || {}).length);
  const totalTokens = $derived(statsTotalTokens(stats));
  const agents = $derived(agentTokenRows(stats));
  // Named the way Claude's /stats names them. Input is uncached: cached input is a cache read.
  const buckets = $derived([
    { label: 'Input', value: stats.total_tokens_in },
    { label: 'Output', value: stats.total_tokens_out },
    { label: 'Cache read', value: stats.total_cache_read_tokens ?? 0 },
    { label: 'Cache write', value: stats.total_cache_write_tokens ?? 0 },
  ]);
</script>

<div class="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-meta text-text-muted">
  <span>Events <span class="tabular ml-1 font-mono text-text">{formatNumber(stats.total_events)}</span></span>
  <span>Sessions <span class="tabular ml-1 font-mono text-text">{sessionCount}</span></span>
  <span>Agents <span class="tabular ml-1 font-mono text-text">{agentCount}</span></span>
  <span>Cost <span class="tabular ml-1 font-mono text-text">{formatCost(stats.total_cost_usd)}</span></span>
  <Popover align="left" width="w-96" label="Token breakdown">
    {#snippet trigger({ toggle, open })}
      <button
        type="button"
        class="flex items-center gap-1 transition-colors hover:text-text"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Tokens {formatNumber(totalTokens)}, show breakdown"
        onclick={toggle}
      >
        Tokens <span class="tabular ml-1 font-mono text-text" data-testid="monitor-total-tokens">{formatNumber(totalTokens)}</span>
        <svg class="h-3 w-3 text-text-faint" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    {/snippet}

    <div class="space-y-3 text-meta">
      <p class="text-text-faint">
        Every token recorded on this machine, cache included. A harness's own
        account total can include other machines and cloud tasks.
      </p>

      <dl class="space-y-1">
        {#each buckets as bucket (bucket.label)}
          <div class="flex items-center justify-between">
            <dt class="text-text-muted">{bucket.label}</dt>
            <dd class="tabular font-mono text-text">{formatNumber(bucket.value)}</dd>
          </div>
        {/each}
      </dl>

      {#if agents.length > 0}
        <div class="space-y-2 border-t border-line pt-3">
          {#each agents as row (row.agent)}
            <div data-testid="monitor-agent-tokens">
              <div class="flex items-center justify-between">
                <span class="font-medium text-text">{row.label}</span>
                <span class="tabular font-mono text-text">{formatNumber(row.total)}</span>
              </div>
              <div class="tabular font-mono text-text-faint">
                in {formatNumber(row.usage.tokens_in)} · out {formatNumber(row.usage.tokens_out)} · read {formatNumber(row.usage.cache_read_tokens)} · write {formatNumber(row.usage.cache_write_tokens)}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </Popover>
</div>
