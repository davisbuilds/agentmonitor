<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LiveItem, LiveSession, LiveTurn } from '../../api/client';
  import { agentName, formatDuration, timeAgo } from '../../format';
  import { rowDurationMs, turnDurationMs } from '../../live-stream-rows';
  import { SubTabs } from '../ui';
  import SessionCoverage from '../shared/SessionCoverage.svelte';
  import { turnTitle } from '../../session-text';
  import TraceDrillInLink from '../trace-quality/TraceDrillInLink.svelte';
  import ContextPill from '../monitor/ContextPill.svelte';
  import { isNotableStatus } from '../../status';

  interface Props {
    session: LiveSession | null;
    turns: LiveTurn[];
    item: LiveItem | null;
    /** The tool result folded into the selected call's row, if any. */
    result?: LiveItem | null;
    /** The session's recent events; given, the Inspector offers them beside the details. */
    events?: Snippet;
    /** Which of the two shows; the page switches back to details when you pick an item. */
    view?: 'details' | 'events';
  }

  let { session, turns, item, result = null, events, view = $bindable('details') }: Props = $props();

  const itemDurationMs = $derived(item ? rowDurationMs({ item, result }) : null);
  const itemTurnDurationMs = $derived(item?.turn_id != null ? turnDurationMs(turns.find(turn => turn.id === item.turn_id)) : null);

  // Every message is a turn, so the full list repeats the stream; only turns
  // that are still running or went wrong are worth listing here.
  const attentionTurns = $derived(turns.filter(turn => isNotableStatus(turn.status)));

  const parsedPayload = $derived.by(() => {
    if (!item) return null;
    try {
      return JSON.parse(item.payload_json) as Record<string, unknown>;
    } catch {
      return null;
    }
  });

  function pretty(target: LiveItem | null): string {
    if (!target) return '';
    try {
      return JSON.stringify(JSON.parse(target.payload_json), null, 2);
    } catch {
      return target.payload_json;
    }
  }

  const prettyPayload = $derived(pretty(item));
  const prettyResult = $derived(pretty(result));

  function steps(payload: Record<string, unknown> | null): Array<{ label: string; status: string | null }> {
    if (!payload || !Array.isArray(payload.steps)) return [];
    return payload.steps
      .map((step) => {
        if (!step || typeof step !== 'object') return null;
        const label = typeof step.label === 'string' ? step.label : null;
        if (!label) return null;
        return {
          label,
          status: typeof step.status === 'string' ? step.status : null,
        };
      })
      .filter(Boolean) as Array<{ label: string; status: string | null }>;
  }

  function turnStatusClasses(status: string | null): string {
    switch (status) {
      case 'completed':
      case 'success':
        return 'text-ok';
      case 'in_progress':
      case 'running':
        return 'text-warn';
      case 'failed':
      case 'error':
        return 'text-danger';
      default:
        return 'text-text-faint';
    }
  }
</script>

<aside class="flex flex-col xl:h-full xl:overflow-hidden">
  <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
    <h3 class="text-h3">Inspector</h3>
    {#if events}
      <SubTabs
        tabs={[{ id: 'details', label: 'Details' }, { id: 'events', label: 'Events' }]}
        active={view}
        onchange={(id) => { view = id as 'details' | 'events'; }}
      />
    {/if}
  </div>

  {#if events && view === 'events'}
    <div class="px-2 py-2 xl:flex-1 xl:overflow-y-auto">
      {@render events()}
    </div>
  {:else}
  <div class="space-y-5 px-4 py-4 xl:flex-1 xl:overflow-y-auto">
    {#if session}
      <section>
        <h4 class="text-meta font-semibold uppercase tracking-wide text-text-faint">Session</h4>
        <div class="mt-2 space-y-2 text-body text-text-muted">
          <div class="flex items-center justify-between gap-3">
            <span class="text-text-faint">ID</span>
            <span class="font-mono text-meta text-text-muted">{session.id}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-text-faint">Trace quality</span>
            <TraceDrillInLink sessionId={session.id} label="Inspect ↗" />
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-text-faint">Agent</span>
            <span>{agentName(session.agent)}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-text-faint">Detail</span>
            <SessionCoverage
              capabilities={session.capabilities}
              integrationMode={session.integration_mode}
              fidelity={session.fidelity}
            />
          </div>
          {#if session.context_pct != null}
            <div class="pt-1">
              <ContextPill
                variant="full"
                pct={session.context_pct}
                usedTokens={session.context_used_tokens}
                windowTokens={session.context_window_tokens}
              />
            </div>
          {/if}
          {#if session.last_item_at}
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-faint">Last item</span>
              <span class="tabular font-mono">{timeAgo(session.last_item_at)}</span>
            </div>
          {/if}
          {#if session.parent_session_id}
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-faint">Parent</span>
              <span class="font-mono text-meta text-text-muted">{session.parent_session_id}</span>
            </div>
          {/if}
        </div>
      </section>
    {/if}

    <section>
      <h4 class="text-meta font-semibold uppercase tracking-wide text-text-faint">Turns</h4>
      {#if turns.length === 0}
        <div class="mt-2 text-meta text-text-muted">No turns yet.</div>
      {:else if attentionTurns.length === 0}
        <div class="mt-2 text-meta text-text-muted">
          {turns.length} turn{turns.length === 1 ? '' : 's'}, none running or failed.
        </div>
      {:else}
        <div class="mt-2 space-y-2">
          {#each attentionTurns as turn (turn.id)}
            <div class="flex items-start justify-between gap-3 rounded-sm border border-line bg-surface-2 px-3 py-2">
              <div class="min-w-0 truncate text-body text-text">{turnTitle(turn.title) ?? `Turn ${turn.id}`}</div>
              <span class={`shrink-0 text-meta ${turnStatusClasses(turn.status)}`}>{turn.status}</span>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    {#if item}
      <section>
        <h4 class="text-meta font-semibold uppercase tracking-wide text-text-faint">Item</h4>
        <div class="mt-2 space-y-2 text-body text-text-muted">
          <div class="flex items-center justify-between gap-3">
            <span class="text-text-faint">Kind</span>
            <span>{item.kind}</span>
          </div>
          {#if isNotableStatus(item.status) || isNotableStatus(result?.status)}
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-faint">Status</span>
              <span>{isNotableStatus(result?.status) ? result?.status : item.status}</span>
            </div>
          {/if}
          {#if itemDurationMs != null}
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-faint">Took</span>
              <span class="tabular font-mono">{formatDuration(itemDurationMs)}</span>
            </div>
          {/if}
          {#if itemTurnDurationMs != null}
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-faint">Turn took</span>
              <span class="tabular font-mono">{formatDuration(itemTurnDurationMs)}</span>
            </div>
          {/if}
          <div class="flex items-center justify-between gap-3">
            <span class="text-text-faint">Ordinal</span>
            <span class="tabular font-mono">#{item.ordinal}</span>
          </div>
        </div>
      </section>

      {#if item.kind === 'plan' && steps(parsedPayload).length > 0}
        <section>
          <h4 class="text-meta font-semibold uppercase tracking-wide text-text-faint">Plan Steps</h4>
          <div class="mt-2 space-y-2">
            {#each steps(parsedPayload) as step, index (`${index}-${step.label}`)}
              <div class="rounded-sm border border-line bg-surface-2 px-3 py-2">
                <div class="text-body text-text">{step.label}</div>
                {#if step.status}
                  <div class="mt-1 text-meta uppercase tracking-wide text-text-faint">{step.status}</div>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <section>
        <h4 class="text-meta font-semibold uppercase tracking-wide text-text-faint">Payload</h4>
        <pre class="mt-2 overflow-x-auto rounded-sm border border-line bg-surface-2 p-3 text-meta text-text-muted">{prettyPayload}</pre>
      </section>

      {#if result}
        <section>
          <h4 class="text-meta font-semibold uppercase tracking-wide text-text-faint">Result</h4>
          <pre class="mt-2 max-h-96 overflow-auto rounded-sm border border-line bg-surface-2 p-3 text-meta text-text-muted">{prettyResult}</pre>
        </section>
      {/if}
    {/if}
  </div>
  {/if}
</aside>
