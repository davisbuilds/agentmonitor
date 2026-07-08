<script lang="ts">
  import { getSessions, getEvents, setSelectedSessionId, getSessionOccupancy } from '../../stores/monitor.svelte';
  import { formatCost, formatNumber, timeAgo, agentColor, parseTimestamp } from '../../format';
  import type { AgentEvent, Session } from '../../api/client';
  import { buildActiveAgentLabel } from '../../monitor-analytics';
  import { SectionHeader, StatusDot, EmptyState, Badge } from '../ui';
  import ContextPill from './ContextPill.svelte';

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
    if (e.status === 'error') return 'bg-danger';
    if (e.event_type === 'tool_use') return 'bg-accent';
    return 'bg-line-strong';
  }
</script>

<SectionHeader title="Active Agents" count={`${sorted.length} session${sorted.length === 1 ? '' : 's'}`} />

{#if sorted.length === 0}
  <EmptyState
    title="No active agent sessions"
    description="Events will appear here as agents connect."
  />
{:else}
  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
    {#each sorted as session (session.id)}
      {@const recentEvents = eventsBySession.get(session.id) || []}
      {@const occupancy = getSessionOccupancy(session.id)}
      <button
        class="w-full cursor-pointer rounded-lg border border-line bg-surface p-4 text-left transition-colors hover:border-line-strong"
        onclick={() => setSelectedSessionId(session.id)}
      >
        <!-- Header -->
        <div class="mb-2 flex items-start justify-between gap-3">
          <div class="flex min-w-0 items-start gap-2">
            <StatusDot status={session.status} class="mt-1.5" />
            <span class="text-body font-medium leading-tight {agentColor(session.agent_type)}">{buildActiveAgentLabel(session.agent_type, recentEvents)}</span>
            {#if session.mode === 'headless'}
              <Badge tone="neutral" class="mt-0.5" title="Headless run (claude -p / codex exec)">headless</Badge>
            {/if}
          </div>
          <div class="flex shrink-0 items-center gap-2">
            {#if occupancy}
              <ContextPill
                pct={occupancy.pct}
                usedTokens={occupancy.used}
                windowTokens={occupancy.window}
              />
            {/if}
            <span class="text-meta text-text-faint">{timeAgo(session.last_event_at)}</span>
          </div>
        </div>

        <!-- Project/Branch -->
        {#if session.project || session.branch}
          <div class="mb-2 truncate text-meta text-text-muted">
            {#if session.project}<span class="text-text">{session.project}</span>{/if}
            {#if session.branch}<span class="ml-1 text-text-faint">({session.branch})</span>{/if}
          </div>
        {/if}

        <!-- Metrics -->
        <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-text-muted">
          <span><span class="tabular font-mono text-text">{session.event_count || 0}</span> events</span>
          <span><span class="tabular font-mono text-text">{formatNumber(session.tokens_in || 0)}</span> in</span>
          <span><span class="tabular font-mono text-text">{formatNumber(session.tokens_out || 0)}</span> out</span>
          {#if session.files_edited}
            <span><span class="tabular font-mono text-text">{session.files_edited}</span> file{session.files_edited === 1 ? '' : 's'}</span>
          {/if}
          {#if session.lines_added}
            <span class="tabular font-mono text-ok">+{formatNumber(session.lines_added)}</span>
          {/if}
          {#if session.lines_removed}
            <span class="tabular font-mono text-danger">-{formatNumber(session.lines_removed)}</span>
          {/if}
          {#if (session.total_cost_usd || 0) > 0}
            <span class="tabular font-mono text-text">{formatCost(session.total_cost_usd || 0)}</span>
          {/if}
        </div>

        <!-- Mini event feed -->
        {#if recentEvents.length > 0}
          <div class="max-h-48 space-y-1 overflow-hidden">
            {#each recentEvents.slice(0, 8) as event}
              <div class="flex items-center gap-2 text-meta">
                <span class="h-1.5 w-1.5 shrink-0 rounded-full {eventStatusDot(event)}"></span>
                <span class="truncate text-text-muted">{eventLabel(event)}</span>
                <span class="ml-auto shrink-0 text-text-faint">{timeAgo(event.created_at)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </button>
    {/each}
  </div>
{/if}
