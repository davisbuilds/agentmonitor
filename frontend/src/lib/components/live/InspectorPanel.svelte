<script lang="ts">
  import type { LiveItem, LiveSession, LiveTurn } from '../../api/client';
  import { timeAgo } from '../../format';
  import ProjectionCapabilities from '../shared/ProjectionCapabilities.svelte';
  import TraceDrillInLink from '../trace-quality/TraceDrillInLink.svelte';
  import ContextPill from '../monitor/ContextPill.svelte';

  interface Props {
    session: LiveSession | null;
    turns: LiveTurn[];
    item: LiveItem | null;
  }

  let { session, turns, item }: Props = $props();

  const parsedPayload = $derived.by(() => {
    if (!item) return null;
    try {
      return JSON.parse(item.payload_json) as Record<string, unknown>;
    } catch {
      return null;
    }
  });

  const prettyPayload = $derived.by(() => {
    if (parsedPayload) return JSON.stringify(parsedPayload, null, 2);
    if (!item) return '';
    return item.payload_json;
  });

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
  <div class="shrink-0 border-b border-line px-4 py-3">
    <h3 class="text-h3">Inspector</h3>
    <p class="mt-0.5 text-meta text-text-muted">
      {#if item}
        Selected {item.kind.replace('_', ' ')} item
      {:else}
        Session metadata and turn state
      {/if}
    </p>
  </div>

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
            <span>{session.agent}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-text-faint">Mode</span>
            <span>{session.integration_mode || 'unknown'}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-text-faint">Fidelity</span>
            <span>{session.fidelity || 'n/a'}</span>
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
          <div class="pt-1">
            <div class="mb-2 text-meta uppercase tracking-wide text-text-faint">Capabilities</div>
            <ProjectionCapabilities capabilities={session.capabilities} />
          </div>
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
        <div class="mt-2 text-meta text-text-muted">No normalized turns yet.</div>
      {:else}
        <div class="mt-2 space-y-2">
          {#each turns as turn (turn.id)}
            <div class="rounded-sm border border-line bg-surface-2 px-3 py-2">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="truncate text-body text-text">{turn.title || turn.source_turn_id || `Turn ${turn.id}`}</div>
                  <div class="mt-1 text-meta text-text-faint">{turn.agent_type}</div>
                </div>
                <span class={`text-meta uppercase tracking-wide ${turnStatusClasses(turn.status)}`}>
                  {turn.status || 'unknown'}
                </span>
              </div>
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
          <div class="flex items-center justify-between gap-3">
            <span class="text-text-faint">Status</span>
            <span>{item.status || 'n/a'}</span>
          </div>
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
    {/if}
  </div>
</aside>
