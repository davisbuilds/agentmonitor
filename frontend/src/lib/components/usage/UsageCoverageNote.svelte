<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatNumber } from '../../format';
  import { InfoTip } from '../ui';

  const coverage = $derived(usage.coverage);
  const sources = $derived(coverage?.source_breakdown.filter(row => row.event_count > 0) ?? []);
</script>

{#if coverage}
  <InfoTip label="these totals" align="right" width="w-96">
    <p>
      Totals add up the events that report tokens or cost:
      <span class="tabular font-mono text-text">{formatNumber(coverage.usage_events)}</span> of
      <span class="tabular font-mono text-text">{formatNumber(coverage.matching_events)}</span> events in this range.
      Hook events mark activity without reporting usage; imported transcripts and telemetry carry it.
    </p>
    {#if sources.length > 0}
      <table class="w-full text-meta">
        <thead class="text-text-faint">
          <tr><th class="text-left font-normal">Source</th><th class="text-right font-normal">With usage</th><th class="text-right font-normal">Events</th></tr>
        </thead>
        <tbody>
          {#each sources as row (row.source)}
            <tr>
              <td class="text-text-muted">{row.source}</td>
              <td class="text-right tabular font-mono">{formatNumber(row.usage_event_count)}</td>
              <td class="text-right tabular font-mono">{formatNumber(row.event_count)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </InfoTip>
{/if}
