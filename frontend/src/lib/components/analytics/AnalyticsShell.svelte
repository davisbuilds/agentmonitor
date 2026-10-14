<script lang="ts">
  import { onMount } from 'svelte';
  import { analyticsFilters } from '../../stores/analytics-filters.svelte';
  import { analytics } from '../../stores/analytics.svelte';
  import { usage } from '../../stores/usage.svelte';
  import { insights } from '../../stores/insights.svelte';
  import { traceQuality } from '../../stores/trace-quality.svelte';
  import { Button, Select, SubTabs } from '../ui';
  import type { AnalyticsView } from '../../route-state';
  import { resolveAnalyticsView, visibleAnalyticsViews } from '../../analytics-views';
  import AnalyticsPage from './AnalyticsPage.svelte';
  import SkillsPage from './SkillsPage.svelte';
  import UsagePage from '../usage/UsagePage.svelte';
  import InsightsPage from '../insights/InsightsPage.svelte';
  import TraceQualityPage from '../trace-quality/TraceQualityPage.svelte';

  const f = analyticsFilters;

  const viewLabels: Record<AnalyticsView, string> = {
    overview: 'Overview',
    usage: 'Usage',
    skills: 'Skills',
    insights: 'Insights',
    quality: 'Quality',
  };

  // Insights does nothing without an LLM API key, so it is offered only once a
  // provider is known to be configured — and not while that is still loading.
  const views = $derived(
    visibleAnalyticsViews(insights.availability).map(id => ({ id, label: viewLabels[id] })),
  );
  // The view actually rendered: an Insights deep link with no key shows
  // Overview, and shows nothing while the key status is unknown.
  const shown = $derived(resolveAnalyticsView(f.view, insights.availability));

  onMount(() => {
    void insights.loadAvailability();
  });

  // Point the hash (and the export/refresh actions) at the view really shown.
  $effect(() => {
    if (shown && shown !== f.view) f.setView(shown);
  });

  const quickRanges = [
    { days: 7, label: '7D' },
    { days: 30, label: '30D' },
    { days: 90, label: '90D' },
  ];

  // Export only exists for the data-backed sub-views; insights has none.
  const canExport = $derived(f.view === 'overview' || f.view === 'usage');

  function refreshActive(): void {
    if (f.view === 'overview') void analytics.fetchAll();
    else if (f.view === 'usage') void usage.fetchAll();
    else if (f.view === 'skills') void analytics.fetchSkillConsultations();
    else if (f.view === 'quality') void traceQuality.load();
    else void insights.load();
  }

  function exportActive(): void {
    if (f.view === 'overview') analytics.exportCsv();
    else if (f.view === 'usage') usage.exportCsv();
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <!-- Shared filter bar: date / project / agent apply across every sub-view. -->
  <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 sm:px-6 py-2.5">
    <SubTabs tabs={views} active={f.view} onchange={(id) => f.setView(id as AnalyticsView)} />

    <div class="mx-1 h-5 w-px bg-line" aria-hidden="true"></div>

    <input
      type="date"
      class="rounded-sm border border-line bg-surface px-2 py-1 text-meta tabular text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
      aria-label="From date"
      value={f.from}
      onchange={(e) => f.setDateRange((e.currentTarget as HTMLInputElement).value, f.to)}
    />
    <span class="text-meta text-text-faint">to</span>
    <input
      type="date"
      class="rounded-sm border border-line bg-surface px-2 py-1 text-meta tabular text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
      aria-label="To date"
      value={f.to}
      onchange={(e) => f.setDateRange(f.from, (e.currentTarget as HTMLInputElement).value)}
    />

    <div class="flex items-center gap-1">
      {#each quickRanges as range}
        <Button variant="ghost" size="sm" onclick={() => f.applyQuickRange(range.days)}>{range.label}</Button>
      {/each}
    </div>

    <Select
      value={f.project}
      options={f.projectOptions}
      placeholder="All Projects"
      aria-label="Filter by project"
      onchange={(value) => f.setProject(value)}
    />
    <Select
      value={f.agent}
      options={f.agentOptions}
      placeholder="All Agents"
      aria-label="Filter by agent"
      onchange={(value) => f.setAgent(value)}
    />

    <div class="ml-auto flex items-center gap-2">
      {#if f.hasActiveSharedFilters}
        <Button variant="ghost" size="sm" onclick={() => f.clearSharedFilters()}>Clear</Button>
      {/if}
      <Button variant="neutral" size="sm" onclick={refreshActive}>Refresh</Button>
      {#if canExport}
        <Button variant="neutral" size="sm" onclick={exportActive}>Export CSV</Button>
      {/if}
    </div>
  </div>

  {#if shown === 'overview'}
    <AnalyticsPage />
  {:else if shown === 'usage'}
    <UsagePage />
  {:else if shown === 'skills'}
    <SkillsPage />
  {:else if shown === 'quality'}
    <TraceQualityPage />
  {:else if shown === 'insights'}
    <InsightsPage />
  {:else}
    <main class="flex-1"></main>
  {/if}
</div>
