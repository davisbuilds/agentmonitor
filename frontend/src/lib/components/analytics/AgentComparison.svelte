<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';
</script>

<section class="rounded-lg border border-line bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-h3">Agent Comparison</h3>
      <p class="mt-0.5 text-meta text-text-muted">Click an agent row to drill the dashboard into that agent.</p>
    </div>
    {#if analytics.agent}
      <span class="text-meta text-accent">Filtered to {analytics.agent}</span>
    {/if}
  </div>

  {#if analytics.loading.agents}
    <div class="py-12 text-center text-meta text-text-muted">Loading agent comparison…</div>
  {:else if analytics.errors.agents}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.agents}</div>
  {:else if analytics.agentComparison.length > 0}
    <div class="overflow-x-auto">
      <table class="min-w-full text-left text-meta text-text-muted">
        <thead class="text-meta uppercase tracking-wide text-text-faint">
          <tr>
            <th class="pb-2 font-medium">Agent</th>
            <th class="pb-2 text-right font-medium">Sessions</th>
            <th class="pb-2 text-right font-medium">Messages</th>
            <th class="pb-2 text-right font-medium">Avg Msgs</th>
            <th class="pb-2 text-right font-medium">Full</th>
            <th class="pb-2 text-right font-medium">Summary</th>
            <th class="pb-2 text-right font-medium">Tool-Capable</th>
          </tr>
        </thead>
        <tbody>
          {#each analytics.agentComparison as row}
            <tr class="border-t border-line">
              <td class="py-2">
                <button class="text-left font-medium text-text transition-colors hover:text-accent" onclick={() => analytics.drillDownToAgent(row.agent)}>
                  {row.agent}
                </button>
              </td>
              <td class="py-2 text-right tabular font-mono">{formatNumber(row.session_count)}</td>
              <td class="py-2 text-right tabular font-mono">{formatNumber(row.message_count)}</td>
              <td class="py-2 text-right tabular font-mono">{row.average_messages_per_session.toFixed(1)}</td>
              <td class="py-2 text-right tabular font-mono">{row.full_fidelity_sessions}</td>
              <td class="py-2 text-right tabular font-mono">{row.summary_fidelity_sessions}</td>
              <td class="py-2 text-right tabular font-mono">{row.tool_analytics_capable_sessions}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="py-12 text-center text-meta text-text-muted">No agent comparison data for this range.</div>
  {/if}
</section>
