<script lang="ts">
  import type { Session } from '../../api/client';
  import { agentColor, formatCost, formatNumber, timeAgo } from '../../format';
  import type { SessionOccupancy } from '../../stores/monitor.svelte';
  import { Badge } from '../ui';
  import ContextPill from './ContextPill.svelte';

  interface Props {
    /** The card's figures for this session (`followedSessionSummary`). */
    session: Session;
    /** The agent and model label the card shows. */
    label: string;
    /** Shown when nothing else on the page carries the context window. */
    occupancy?: SessionOccupancy | null;
  }

  let { session, label, occupancy = null }: Props = $props();
</script>

<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-text-muted" data-testid="session-summary">
  <span class="font-medium {agentColor(session.agent_type)}">{label}</span>
  {#if session.mode === 'headless'}
    <Badge tone="neutral" title="Headless run (claude -p / codex exec)">headless</Badge>
  {:else if session.mode === 'interactive'}
    <span>interactive</span>
  {/if}
  {#if session.branch}<span class="font-mono text-text-faint">{session.branch}</span>{/if}
  {#if session.started_at}
    <span>Started <span class="tabular font-mono text-text">{timeAgo(session.started_at)}</span></span>
  {/if}
  <span><span class="tabular font-mono text-text">{formatNumber(session.event_count || 0)}</span> event{session.event_count === 1 ? '' : 's'}</span>
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
  <span class="tabular font-mono text-text" data-testid="session-summary-cost">{formatCost(session.total_cost_usd || 0)}</span>
  {#if occupancy}
    <ContextPill pct={occupancy.pct} usedTokens={occupancy.used} windowTokens={occupancy.window} />
  {/if}
</div>
