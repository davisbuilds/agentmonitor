<script lang="ts">
  import { getSessions, getEvents, setSelectedSessionId } from '../../stores/monitor.svelte';
  import { formatCost, formatNumber, timeAgo, statusColor, agentColor, parseTimestamp } from '../../format';
  import type { AgentEvent, Session } from '../../api/client';
  import { buildActiveAgentLabel } from '../../monitor-analytics';

  const sessions = $derived(getSessions());
  const events = $derived(getEvents());

  // Group recent events by session
  const eventsBySession = $derived.by(() => {
    const map = new Map<string, AgentEvent[]>();
    for (const e of events) {
      const arr = map.get(e.session_id) || [];
      arr.push(e);
      if (arr.length <= 8) map.set(e.session_id, arr);
    }
    return map;
  });

  // Sort: active first, then idle, then by last_event_at desc
  const sorted = $derived.by(() => {
    return [...sessions].sort((a, b) => {
      const statusOrder: Record<string, number> = { active: 0, idle: 1, ended: 2 };
      const sa = statusOrder[a.status] ?? 2;
      const sb = statusOrder[b.status] ?? 2;
      if (sa !== sb) return sa - sb;
      return parseTimestamp(b.last_event_at).getTime() - parseTimestamp(a.last_event_at).getTime();
    });
  });

  function eventLabel(e: AgentEvent): string {
    if (e.event_type === 'tool_use' && e.tool_name) return e.tool_name;
    return e.event_type;
  }

  function eventStatusDot(e: AgentEvent): string {
    if (e.status === 'error') return 'bg-red-400';
    if (e.event_type === 'tool_use') return 'bg-blue-400';
    if (e.event_type === 'llm_response') return 'bg-purple-400';
    return 'bg-gray-500';
  }
</script>

<div class="flex items-center justify-between mb-3">
  <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">Active Agents</h2>
  <span class="text-xs text-gray-500">{sorted.length} sessions</span>
</div>

<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {#if sorted.length === 0}
    <div class="col-span-full text-center py-12 text-gray-500">
      No active agent sessions. Events will appear here as agents connect.
    </div>
  {:else}
    {#each sorted as session (session.id)}
      {@const recentEvents = eventsBySession.get(session.id) || []}
      <button
        class="bg-gray-900 rounded-lg border border-gray-700 p-4 text-left hover:border-gray-500 transition-colors cursor-pointer w-full"
        onclick={() => setSelectedSessionId(session.id)}
      >
        <!-- Header -->
        <div class="flex items-start justify-between gap-3 mb-2">
          <div class="flex items-start gap-2 min-w-0">
            <span class="mt-1.5 w-2 h-2 rounded-full shrink-0 {statusColor(session.status)}"></span>
            <span class="text-sm font-medium leading-tight {agentColor(session.agent_type)}">{buildActiveAgentLabel(session.agent_type, recentEvents)}</span>
          </div>
          <span class="text-xs text-gray-500 shrink-0">{timeAgo(session.last_event_at)}</span>
        </div>

        <!-- Project/Branch -->
        {#if session.project || session.branch}
          <div class="text-xs text-gray-400 mb-2 truncate">
            {#if session.project}<span class="text-gray-300">{session.project}</span>{/if}
            {#if session.branch}<span class="text-gray-500 ml-1">({session.branch})</span>{/if}
          </div>
        {/if}

        <!-- Metrics -->
        <div class="flex items-center gap-4 text-xs text-gray-500 mb-3">
          <span>{session.event_count || 0} events</span>
          <span>{formatNumber(session.tokens_in || 0)} in</span>
          <span>{formatNumber(session.tokens_out || 0)} out</span>
          {#if session.files_edited}
            <span>{session.files_edited} file{session.files_edited === 1 ? '' : 's'}</span>
          {/if}
          {#if session.lines_added}
            <span class="text-emerald-400">+{formatNumber(session.lines_added)}</span>
          {/if}
          {#if session.lines_removed}
            <span class="text-red-400">-{formatNumber(session.lines_removed)}</span>
          {/if}
          {#if (session.total_cost_usd || 0) > 0}
            <span>{formatCost(session.total_cost_usd || 0)}</span>
          {/if}
        </div>

        <!-- Mini event feed -->
        {#if recentEvents.length > 0}
          <div class="space-y-1 max-h-48 overflow-hidden">
            {#each recentEvents.slice(0, 8) as event}
              <div class="flex items-center gap-2 text-xs">
                <span class="w-1.5 h-1.5 rounded-full {eventStatusDot(event)} shrink-0"></span>
                <span class="text-gray-400 truncate">{eventLabel(event)}</span>
                <span class="text-gray-600 ml-auto shrink-0">{timeAgo(event.created_at)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </button>
    {/each}
  {/if}
</div>
