<script lang="ts">
  import type { LiveSession } from '../../api/client';
  import { agentHexColor, timeAgo } from '../../format';
  import { getSessionPreviewText } from '../../session-text';
  import ProjectionCapabilities from '../shared/ProjectionCapabilities.svelte';

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

  function titleFor(session: LiveSession): string {
    return getSessionPreviewText(session.first_message)
      || (session.message_count > 0 ? 'Live agent activity' : session.id.slice(0, 12));
  }

  function statusClasses(status: string | null): string {
    switch (status) {
      case 'live':
      case 'active':
        return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
      case 'idle':
        return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
      case 'ended':
        return 'bg-slate-500/15 text-slate-300 border-slate-500/30';
      default:
        return 'bg-gray-700/40 text-gray-300 border-gray-700';
    }
  }
</script>

<div class="flex-1 overflow-y-auto space-y-2">
  {#if loading && sessions.length === 0}
    <div class="text-sm text-gray-500 py-8 text-center">Loading live sessions...</div>
  {:else if error}
    <div class="text-sm text-red-400 py-8 text-center">{error}</div>
  {:else if sessions.length === 0}
    <div class="text-sm text-gray-500 py-8 text-center">No live sessions match the current filters.</div>
  {:else}
    {#each sessions as { session, depth } (session.id)}
      <button
        class="w-full text-left rounded-lg border px-3 py-2 transition-colors {selectedSessionId === session.id ? 'border-blue-500/60 bg-blue-500/10' : 'border-gray-800 bg-gray-900/50 hover:border-gray-700 hover:bg-gray-900/80'}"
        style={`margin-left: ${Math.min(depth * 14, 42)}px; width: calc(100% - ${Math.min(depth * 14, 42)}px);`}
        onclick={() => onselect(session.id)}
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 min-w-0">
              <span
                class="inline-block h-2 w-2 rounded-full shrink-0"
                style={`background-color: ${agentHexColor(session.agent)}`}
              ></span>
              <span class="truncate text-sm text-gray-200">{titleFor(session)}</span>
            </div>
            <div class="mt-1 flex items-center gap-2 flex-wrap text-xs text-gray-500">
              {#if session.project}
                <span class="rounded bg-gray-800 px-1.5 py-0.5">{session.project}</span>
              {/if}
              {#if session.relationship_type}
                <span class="rounded bg-gray-800 px-1.5 py-0.5 uppercase tracking-wide">{session.relationship_type}</span>
              {/if}
              <span>{session.message_count} msgs</span>
              {#if session.last_item_at}
                <span>{timeAgo(session.last_item_at)}</span>
              {:else if session.started_at}
                <span>{timeAgo(session.started_at)}</span>
              {/if}
            </div>
          </div>
          <div class="flex flex-col items-end gap-1 shrink-0">
            <span class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusClasses(session.live_status)}`}>
              {session.live_status || 'unknown'}
            </span>
            <ProjectionCapabilities capabilities={session.capabilities} variant="summary" />
          </div>
        </div>
      </button>
    {/each}

    {#if hasMore}
      <div class="pt-2 text-center">
        <button class="text-sm text-blue-400 hover:text-blue-300" onclick={onloadmore}>
          Load more sessions
        </button>
      </div>
    {/if}
  {/if}
</div>
