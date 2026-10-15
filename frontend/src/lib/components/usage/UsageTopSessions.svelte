<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatModelName, formatNumber } from '../../format';
  import { sessionTitle } from '../../session-text';
  import { Button, InfoTip } from '../ui';
  import TraceDrillInLink from '../trace-quality/TraceDrillInLink.svelte';

  function openSession(sessionId: string, available: boolean): void {
    if (!available) return;
    usage.openSession(sessionId);
  }
</script>

<section class="flex h-full flex-col rounded-lg border border-line bg-surface p-4 xl:max-h-[34rem]">
  <div>
    <div class="flex items-center gap-1.5">
      <h3 class="text-h3">Top Sessions</h3>
      <InfoTip label="Top Sessions"><p>Highest-cost sessions in the range. Sessions with no transcript still appear, from their usage events.</p></InfoTip>
    </div>
  </div>

  {#if usage.loading.topSessions}
    <div class="mt-4 flex-1 space-y-2 overflow-y-auto pr-1">
      {#each Array.from({ length: 5 }) as _}
        <div class="h-14 animate-pulse rounded-sm bg-surface-2"></div>
      {/each}
    </div>
  {:else if usage.errors.topSessions}
    <div class="mt-4 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-meta text-danger">
      {usage.errors.topSessions}
    </div>
  {:else if usage.topSessions.length === 0}
    <div class="mt-4 flex flex-1 items-center justify-center rounded-sm border border-dashed border-line px-4 py-10 text-center text-meta text-text-faint">
      No usage-bearing sessions in this range.
    </div>
  {:else}
    <div class="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
      <div class="space-y-2">
      {#each usage.topSessions as row}
        <div class="rounded-lg border border-line bg-surface-2 px-3 py-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-body font-medium text-text" title={row.id}>{sessionTitle(row)}</div>
              <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-meta text-text-faint">
                <span>{row.project ?? 'unknown project'}</span>
                <span>{row.agent}</span>
                <span class="font-mono" title={row.primary_model}>{formatModelName(row.primary_model)}</span>
                <span>{row.primary_provider} / {row.primary_tier}</span>
                <span class="tabular font-mono">{formatNumber(row.usage_events)} usage events</span>
                <span class="tabular font-mono">{formatNumber(row.input_tokens + row.output_tokens)} tokens</span>
              </div>
            </div>
            <div class="text-right">
              <div class="tabular font-mono text-body text-ok">{formatCost(row.cost_usd)}</div>
              <div class="mt-1 tabular font-mono text-meta text-text-faint">
                {row.last_activity_at ? row.last_activity_at.slice(0, 10) : 'No timestamp'}
              </div>
            </div>
          </div>

          <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-text-faint">
              <span class="tabular font-mono">{formatNumber(row.event_count)} events</span>
              {#if row.message_count != null}
                <span class="tabular font-mono">{formatNumber(row.message_count)} messages</span>
              {/if}
              {#if row.model_count > 1}
                <span class="tabular font-mono">{formatNumber(row.model_count)} models</span>
              {/if}
              {#if row.unknown_model_events > 0}
                <span class="inline-flex items-center gap-1.5 text-warn">
                  <span class="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true"></span>
                  {formatNumber(row.unknown_model_events)} unpriced events
                </span>
              {/if}
            </div>

            <div class="flex items-center gap-1.5">
              <TraceDrillInLink sessionId={row.id} />
              <Button
                variant="neutral"
                size="sm"
                disabled={!row.browsing_session_available}
                onclick={() => openSession(row.id, row.browsing_session_available)}
              >
                {row.browsing_session_available ? 'Open Session' : 'Events Only'}
              </Button>
            </div>
          </div>
        </div>
      {/each}
      </div>
    </div>
  {/if}
</section>
