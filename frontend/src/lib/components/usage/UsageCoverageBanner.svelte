<script lang="ts">
  import { usage } from '../../stores/usage.svelte';
  import { formatCost, formatNumber } from '../../format';

  const banner = $derived.by(() => {
    const coverage = usage.coverage;
    if (!coverage) return null;

    const usageRatio = coverage.matching_events > 0
      ? `${coverage.usage_events}/${coverage.matching_events}`
      : '0/0';
    const sourceSummary = coverage.source_breakdown
      .filter(row => row.event_count > 0)
      .map(row => `${row.source}: ${row.usage_event_count}/${row.event_count}`)
      .join(' • ');

    if (coverage.missing_usage_events > 0) {
      return {
        dot: 'bg-warn',
        title: 'Usage totals are event-derived.',
        body: `${usageRatio} matching events carry cost or token data. ${coverage.missing_usage_events} matching event${coverage.missing_usage_events === 1 ? '' : 's'} are excluded from totals. ${sourceSummary}`,
      };
    }

    const totalCost = usage.summary ? formatCost(usage.summary.total_cost_usd) : '$0.00';
    return {
      dot: 'bg-accent',
      title: 'Complete event coverage for this slice.',
      body: `${formatNumber(coverage.usage_events)} usage events across ${formatNumber(coverage.usage_sessions)} session${coverage.usage_sessions === 1 ? '' : 's'} contributed ${totalCost}. ${sourceSummary}`,
    };
  });
</script>

{#if banner}
  <div class="flex items-start gap-2 text-meta text-text-muted">
    <span class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full {banner.dot}" aria-hidden="true"></span>
    <p class="max-w-[80ch]"><span class="text-text">{banner.title}</span> {banner.body}</p>
  </div>
{/if}
