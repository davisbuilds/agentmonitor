<script lang="ts">
  import { getStats } from '../../stores/monitor.svelte';
  import { formatCost, formatNumber } from '../../format';

  const stats = $derived(getStats());
  const sessionCount = $derived(Number.isFinite(stats.live_sessions) ? stats.live_sessions : stats.active_sessions);
  const agentCount = $derived(Number.isFinite(stats.active_agents) ? stats.active_agents : Object.keys(stats.agent_breakdown || {}).length);
</script>

<div class="flex items-center gap-3 sm:gap-5 text-sm text-gray-400 flex-wrap">
  <span>Events: <span class="text-white font-medium">{formatNumber(stats.total_events)}</span></span>
  <span>Sessions: <span class="text-white font-medium">{sessionCount}</span></span>
  <span>Agents: <span class="text-white font-medium">{agentCount}</span></span>
  <span>Cost: <span class="text-white font-medium">{formatCost(stats.total_cost_usd)}</span></span>
  <span class="hidden sm:inline">Tokens: <span class="text-white font-medium">{formatNumber(stats.total_tokens_in)}</span> in / <span class="text-white font-medium">{formatNumber(stats.total_tokens_out)}</span> out</span>
</div>
