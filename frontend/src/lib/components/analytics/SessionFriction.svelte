<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { agentHexColor, formatNumber, timeAgo } from '../../format';
  import { frictionDescription, frictionLabel } from '../../friction-signals';
  import { sessionTitle } from '../../session-text';
  import { InfoTip } from '../ui';

  const friction = $derived(analytics.friction);
</script>

<section class="rounded-lg border border-line bg-surface p-4" aria-labelledby="session-friction-heading">
  <div class="mb-3 flex items-center gap-1.5">
    <h3 id="session-friction-heading" class="text-h3">Friction</h3>
    <InfoTip label="Friction">
      <p>Sessions you started where the agent got stuck: three or more tool calls failing in a row, or you stopping it. Both are inferred from transcripts and telemetry, and neither grows with how long a session ran, so a deep session is not counted as a troubled one. Codex interruptions are not recorded yet. Select a signal to open the session where it starts.</p>
    </InfoTip>
  </div>

  {#if analytics.loading.friction && !friction}
    <div class="py-12 text-center text-meta text-text-muted">Loading friction…</div>
  {:else if analytics.errors.friction}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.friction}</div>
  {:else if !friction || friction.sessions === 0}
    <div class="py-12 text-center text-meta text-text-muted">No sessions in the selected range.</div>
  {:else}
    <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-meta text-text-muted">
      <span>
        <span class="tabular font-mono text-h3 text-text">{formatNumber(friction.with_friction)}</span>
        of {formatNumber(friction.sessions)} session{friction.sessions === 1 ? '' : 's'} met friction
      </span>
      {#if friction.with_friction > 0}
        <span>
          <span class="tabular font-mono text-text">{formatNumber(friction.failure_streaks)}</span> failure streak{friction.failure_streaks === 1 ? '' : 's'} ·
          <span class="tabular font-mono text-text">{formatNumber(friction.interruptions)}</span> interrupted
        </span>
      {/if}
    </div>

    {#if friction.recent.length > 0}
      <ul class="mt-3 space-y-2.5" aria-label="Latest sessions that met friction">
        {#each friction.recent as row (row.id)}
          <li data-testid="friction-session">
            <div class="flex items-baseline justify-between gap-3 text-meta">
              <button class="flex min-w-0 items-center gap-2 text-left text-text hover:text-accent focus-visible:text-accent"
                onclick={() => analytics.openSession(row.id)}>
                <span class="h-2 w-2 shrink-0 rounded-full" style={`background:${agentHexColor(row.agent)}`} aria-hidden="true"></span>
                <span class="truncate">{sessionTitle(row)}</span>
              </button>
              {#if row.started_at}
                <span class="shrink-0 tabular font-mono text-text-faint">{timeAgo(row.started_at)}</span>
              {/if}
            </div>
            <div class="mt-1 flex flex-wrap gap-1.5 pl-4">
              {#each row.signals as signal (signal.kind)}
                <button
                  class="rounded-sm border border-line px-1.5 py-0.5 text-meta text-text-muted transition-colors hover:border-line-strong hover:text-text focus-visible:border-line-strong focus-visible:text-text"
                  title={frictionDescription(signal)}
                  aria-label={`${frictionLabel(signal)}. ${frictionDescription(signal)}`}
                  onclick={() => analytics.openSessionAt(row.id, signal.ordinal)}
                >{frictionLabel(signal)}</button>
              {/each}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
