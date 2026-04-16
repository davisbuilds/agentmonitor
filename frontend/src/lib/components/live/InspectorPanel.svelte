<script lang="ts">
  import type { LiveItem, LiveSession, LiveTurn } from '../../api/client';
  import { timeAgo } from '../../format';
  import ProjectionCapabilities from '../shared/ProjectionCapabilities.svelte';

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
        return 'text-emerald-300';
      case 'in_progress':
      case 'running':
        return 'text-amber-300';
      case 'failed':
      case 'error':
        return 'text-red-300';
      default:
        return 'text-gray-400';
    }
  }
</script>

<aside class="flex flex-col xl:h-full xl:overflow-hidden">
  <div class="border-b border-gray-800 px-4 py-3 shrink-0">
    <h3 class="text-sm font-semibold text-gray-100">Inspector</h3>
    <p class="mt-1 text-xs text-gray-500">
      {#if item}
        Selected {item.kind.replace('_', ' ')} item
      {:else}
        Session metadata and turn state
      {/if}
    </p>
  </div>

  <div class="px-4 py-4 space-y-5 xl:flex-1 xl:overflow-y-auto">
    {#if session}
      <section>
        <h4 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Session</h4>
        <div class="mt-2 space-y-2 text-sm text-gray-300">
          <div class="flex items-center justify-between gap-3">
            <span class="text-gray-500">ID</span>
            <span class="font-mono text-xs text-gray-400">{session.id}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-gray-500">Agent</span>
            <span>{session.agent}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-gray-500">Mode</span>
            <span>{session.integration_mode || 'unknown'}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-gray-500">Fidelity</span>
            <span>{session.fidelity || 'n/a'}</span>
          </div>
          <div class="pt-1">
            <div class="mb-2 text-xs uppercase tracking-wide text-gray-500">Capabilities</div>
            <ProjectionCapabilities capabilities={session.capabilities} />
          </div>
          {#if session.last_item_at}
            <div class="flex items-center justify-between gap-3">
              <span class="text-gray-500">Last item</span>
              <span>{timeAgo(session.last_item_at)}</span>
            </div>
          {/if}
          {#if session.parent_session_id}
            <div class="flex items-center justify-between gap-3">
              <span class="text-gray-500">Parent</span>
              <span class="font-mono text-xs text-gray-400">{session.parent_session_id}</span>
            </div>
          {/if}
        </div>
      </section>
    {/if}

    <section>
      <h4 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Turns</h4>
      {#if turns.length === 0}
        <div class="mt-2 text-sm text-gray-500">No normalized turns yet.</div>
      {:else}
        <div class="mt-2 space-y-2">
          {#each turns as turn (turn.id)}
            <div class="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="truncate text-sm text-gray-200">{turn.title || turn.source_turn_id || `Turn ${turn.id}`}</div>
                  <div class="mt-1 text-xs text-gray-500">{turn.agent_type}</div>
                </div>
                <span class={`text-xs uppercase tracking-wide ${turnStatusClasses(turn.status)}`}>
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
        <h4 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Item</h4>
        <div class="mt-2 space-y-2 text-sm text-gray-300">
          <div class="flex items-center justify-between gap-3">
            <span class="text-gray-500">Kind</span>
            <span>{item.kind}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-gray-500">Status</span>
            <span>{item.status || 'n/a'}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-gray-500">Ordinal</span>
            <span>#{item.ordinal}</span>
          </div>
        </div>
      </section>

      {#if item.kind === 'plan' && steps(parsedPayload).length > 0}
        <section>
          <h4 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Plan Steps</h4>
          <div class="mt-2 space-y-2">
            {#each steps(parsedPayload) as step, index (`${index}-${step.label}`)}
              <div class="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
                <div class="text-sm text-gray-200">{step.label}</div>
                {#if step.status}
                  <div class="mt-1 text-xs text-gray-500 uppercase tracking-wide">{step.status}</div>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <section>
        <h4 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Payload</h4>
        <pre class="mt-2 overflow-x-auto rounded-xl border border-gray-800 bg-gray-900/70 p-3 text-xs text-gray-300">{prettyPayload}</pre>
      </section>
    {/if}
  </div>
</aside>
