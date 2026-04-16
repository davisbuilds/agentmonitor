<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { formatNumber } from '../../format';
</script>

<section class="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold text-gray-200">Agent Comparison</h3>
      <p class="text-xs text-gray-500">Click an agent row to drill the dashboard into that agent.</p>
    </div>
    {#if analytics.agent}
      <span class="text-xs text-amber-300">Filtered to {analytics.agent}</span>
    {/if}
  </div>

  {#if analytics.loading.agents}
    <div class="py-12 text-center text-sm text-gray-500">Loading agent comparison...</div>
  {:else if analytics.errors.agents}
    <div class="py-12 text-center text-sm text-red-300">{analytics.errors.agents}</div>
  {:else if analytics.agentComparison.length > 0}
    <div class="overflow-x-auto">
      <table class="min-w-full text-left text-xs text-gray-300">
        <thead class="text-[11px] uppercase tracking-wide text-gray-500">
          <tr>
            <th class="pb-2">Agent</th>
            <th class="pb-2 text-right">Sessions</th>
            <th class="pb-2 text-right">Messages</th>
            <th class="pb-2 text-right">Avg Msgs</th>
            <th class="pb-2 text-right">Full</th>
            <th class="pb-2 text-right">Summary</th>
            <th class="pb-2 text-right">Tool-Capable</th>
          </tr>
        </thead>
        <tbody>
          {#each analytics.agentComparison as row}
            <tr class="border-t border-gray-800">
              <td class="py-2">
                <button class="font-medium text-left text-gray-100 hover:text-blue-300" onclick={() => analytics.drillDownToAgent(row.agent)}>
                  {row.agent}
                </button>
              </td>
              <td class="py-2 text-right">{formatNumber(row.session_count)}</td>
              <td class="py-2 text-right">{formatNumber(row.message_count)}</td>
              <td class="py-2 text-right">{row.average_messages_per_session.toFixed(1)}</td>
              <td class="py-2 text-right">{row.full_fidelity_sessions}</td>
              <td class="py-2 text-right">{row.summary_fidelity_sessions}</td>
              <td class="py-2 text-right">{row.tool_analytics_capable_sessions}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="py-12 text-center text-sm text-gray-500">No agent comparison data for this range.</div>
  {/if}
</section>
