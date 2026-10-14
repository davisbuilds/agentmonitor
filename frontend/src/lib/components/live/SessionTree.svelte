<script lang="ts">
  import type { LiveSession } from '../../api/client';
  import { agentHexColor, timeAgo } from '../../format';
  import { sessionTitle } from '../../session-text';
  import { liveDotStatus } from '../../status';
  import SessionCoverage from '../shared/SessionCoverage.svelte';
  import { Badge, Button, StatusDot } from '../ui';

  interface SessionTreeNode {
    session: LiveSession;
    depth: number;
  }

  interface Props {
    sessions: SessionTreeNode[];
    selectedSessionId: string | null;
    loading: boolean;
    error: string | null;
    hasMore: boolean;
    onselect: (sessionId: string) => void;
    onloadmore: () => void;
  }

  let { sessions, selectedSessionId, loading, error, hasMore, onselect, onloadmore }: Props = $props();


</script>

<div class="space-y-2 xl:flex-1 xl:overflow-y-auto">
  {#if loading && sessions.length === 0}
    <div class="py-8 text-center text-meta text-text-muted">Loading live sessions…</div>
  {:else if error}
    <div class="py-8 text-center text-meta text-danger">{error}</div>
  {:else if sessions.length === 0}
    <div class="py-8 text-center text-meta text-text-muted">No live sessions match the current filters.</div>
  {:else}
    {#each sessions as { session, depth } (session.id)}
      <button
        class="w-full rounded-sm border px-3 py-2 text-left transition-colors {selectedSessionId === session.id ? 'border-accent/50 bg-accent/10' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2'}"
        style={`margin-left: ${Math.min(depth * 14, 42)}px; width: calc(100% - ${Math.min(depth * 14, 42)}px);`}
        onclick={() => onselect(session.id)}
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <span
                class="inline-block h-2 w-2 shrink-0 rounded-full"
                style={`background-color: ${agentHexColor(session.agent)}`}
              ></span>
              <span class="truncate text-body text-text">{sessionTitle(session)}</span>
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-meta text-text-faint">
              {#if session.project}
                <Badge tone="neutral">{session.project}</Badge>
              {/if}
              <span class="tabular font-mono">{session.message_count} msgs</span>
              {#if session.last_item_at}
                <span class="tabular font-mono">{timeAgo(session.last_item_at)}</span>
              {:else if session.started_at}
                <span class="tabular font-mono">{timeAgo(session.started_at)}</span>
              {/if}
            </div>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-1">
            <StatusDot status={liveDotStatus(session.live_status)} label={session.live_status || 'unknown'} />
            <SessionCoverage capabilities={session.capabilities} variant="row" />
          </div>
        </div>
      </button>
    {/each}

    {#if hasMore}
      <div class="pt-2 text-center">
        <Button variant="ghost" size="sm" onclick={onloadmore}>Load more sessions</Button>
      </div>
    {/if}
  {/if}
</div>
