<script lang="ts">
  import { Badge, EmptyState } from '../ui';
  import type { TraceQualityPromptRollup } from '../../api/client';

  interface Props {
    prompts: TraceQualityPromptRollup[];
  }

  let { prompts }: Props = $props();

  function formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
  }
  function formatCost(value: number): string {
    return `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
  }
  function formatDuration(ms: number | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 60000)}m`;
  }
  function formatScore(value: number | null): string {
    return value == null ? '—' : value.toFixed(2);
  }
  function lastSeen(value: string | null): string {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
  }
</script>

<section class="space-y-3">
  <h3 class="text-h3">Prompt versions</h3>

  {#if prompts.length === 0}
    <EmptyState title="No prompt attribution in this window." description="Prompt rollups appear once generations are linked to a skill, system, or task-template prompt reference." />
  {:else}
    <div class="overflow-x-auto rounded-lg border border-line bg-surface">
      <table class="w-full min-w-[52rem] border-collapse text-meta">
        <thead>
          <tr class="border-b border-line text-left text-text-faint">
            <th class="px-3 py-2 font-medium">Prompt</th>
            <th class="px-3 py-2 text-right font-medium">Gens</th>
            <th class="px-3 py-2 text-right font-medium">Med dur</th>
            <th class="px-3 py-2 text-right font-medium">Cost</th>
            <th class="px-3 py-2 text-right font-medium">Tokens (in/out)</th>
            <th class="px-3 py-2 text-right font-medium">Scores</th>
            <th class="px-3 py-2 text-right font-medium">Med score</th>
            <th class="px-3 py-2 text-right font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {#each prompts as prompt (prompt.id)}
            <tr class="border-b border-line/60 last:border-0 hover:bg-surface-2">
              <td class="px-3 py-2">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-text">{prompt.name}{prompt.version ? `@${prompt.version}` : ''}</span>
                  <Badge tone="neutral">{prompt.source}</Badge>
                </div>
                {#if prompt.label}<div class="mt-0.5 text-text-faint">{prompt.label}</div>{/if}
              </td>
              <td class="px-3 py-2 text-right font-mono tabular text-text-muted">{formatNumber(prompt.generation_count)}</td>
              <td class="px-3 py-2 text-right font-mono tabular text-text-muted">{formatDuration(prompt.median_duration_ms)}</td>
              <td class="px-3 py-2 text-right font-mono tabular text-text-muted">{formatCost(prompt.total_cost_usd)}</td>
              <td class="px-3 py-2 text-right font-mono tabular text-text-muted">
                {formatNumber(prompt.total_tokens_in)}/{formatNumber(prompt.total_tokens_out)}
              </td>
              <td class="px-3 py-2 text-right font-mono tabular text-text-muted">{formatNumber(prompt.score_count)}</td>
              <td class="px-3 py-2 text-right font-mono tabular text-text-muted">{formatScore(prompt.median_numeric_score)}</td>
              <td class="px-3 py-2 text-right font-mono tabular text-text-faint">{lastSeen(prompt.last_seen)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
