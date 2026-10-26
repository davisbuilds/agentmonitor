<script lang="ts">
  import { onMount } from 'svelte';
  import { analyticsFilters } from '../../stores/analytics-filters.svelte';
  import { analytics } from '../../stores/analytics.svelte';
  import { usage } from '../../stores/usage.svelte';
  import { insights } from '../../stores/insights.svelte';
  import { traceQuality } from '../../stores/trace-quality.svelte';
  import { Button, Field, FilterBar, MoreFilters, Popover, Select, SubTabs } from '../ui';
  import { formatDateRange, modelSelectOptions } from '../../format';
  import { QUICK_RANGE_DAYS } from '../../analytics-state';
  import type { AnalyticsView } from '../../route-state';
  import { resolveAnalyticsView, visibleAnalyticsViews } from '../../analytics-views';
  import AnalyticsPage from './AnalyticsPage.svelte';
  import SkillsPage from './SkillsPage.svelte';
  import UsagePage from '../usage/UsagePage.svelte';
  import InsightsPage from '../insights/InsightsPage.svelte';
  import TraceQualityPage from '../trace-quality/TraceQualityPage.svelte';

  const f = analyticsFilters;
  // Apply a deep link before the first render, so `#analytics?view=usage`
  // mounts Usage straight away instead of mounting Overview and its reads first.
  f.attachHash();

  const viewLabels: Record<AnalyticsView, string> = {
    overview: 'Overview',
    usage: 'Usage',
    skills: 'Skills',
    insights: 'Insights',
    quality: 'Quality',
  };

  // Insights is offered once a provider key or a saved insight is known to exist
  // (saved ones stay readable after keys are removed) — not while that loads.
  const views = $derived(
    visibleAnalyticsViews(insights.availability).map(id => ({ id, label: viewLabels[id] })),
  );
  // The view actually rendered: an Insights deep link with neither a key nor a
  // saved insight shows Overview, and shows nothing while that is unknown.
  const shown = $derived(resolveAnalyticsView(f.view, insights.availability));

  onMount(() => {
    void insights.loadAvailability();
  });

  // Point the hash (and the export/refresh actions) at the view really shown.
  $effect(() => {
    if (shown && shown !== f.view) f.setView(shown);
  });

  // The range button names the window every figure below covers.
  const rangeLabel = $derived(formatDateRange(f.from, f.to));
  const usageFacetCount = $derived([usage.provider, usage.tier, usage.model].filter(Boolean).length);

  // Export only exists for the data-backed sub-views; insights and quality have none.
  const canExport = $derived(f.view === 'overview' || f.view === 'usage' || f.view === 'skills');

  function refreshActive(): void {
    if (f.view === 'overview') void analytics.fetchAll();
    else if (f.view === 'usage') void usage.fetchAll();
    else if (f.view === 'skills') void analytics.fetchSkillsView();
    else if (f.view === 'quality') void traceQuality.load();
    else void insights.load();
  }

  function exportActive(): void {
    if (f.view === 'overview') analytics.exportCsv();
    else if (f.view === 'usage') usage.exportCsv();
    else if (f.view === 'skills') analytics.exportSkillsCsv();
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <!-- Date, project and agent apply across every sub-view; Usage adds its own facets. -->
  <FilterBar>
    <SubTabs tabs={views} active={f.view} onchange={(id) => f.setView(id as AnalyticsView)} />

    <div class="mx-1 h-5 w-px bg-line" aria-hidden="true"></div>

    <Popover align="left" width="w-64" label="Date range">
      {#snippet trigger({ toggle, open })}
        <Button variant="neutral" size="sm" aria-label="Date range {rangeLabel}" onclick={toggle}>
          <span class="tabular">{rangeLabel}</span>
          <svg
            class="h-3 w-3 text-text-faint transition-transform {open ? 'rotate-180' : ''}"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </Button>
      {/snippet}
      <div class="space-y-3">
        <Field label="From">
          <input
            type="date"
            class="w-full rounded-sm border border-line bg-surface px-2 py-1.5 text-meta tabular text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
            aria-label="From date"
            value={f.from}
            onchange={(e) => f.setDateRange((e.currentTarget as HTMLInputElement).value, f.to)}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            class="w-full rounded-sm border border-line bg-surface px-2 py-1.5 text-meta tabular text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
            aria-label="To date"
            value={f.to}
            onchange={(e) => f.setDateRange(f.from, (e.currentTarget as HTMLInputElement).value)}
          />
        </Field>
      </div>
    </Popover>

    <div class="flex items-center gap-0.5">
      {#each QUICK_RANGE_DAYS as days}
        <button
          type="button"
          class="rounded-sm px-2 py-1 text-meta transition-colors {f.activeQuickRange === days ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface hover:text-text'}"
          aria-pressed={f.activeQuickRange === days}
          onclick={() => f.applyQuickRange(days)}
        >{days}D</button>
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

    {#if shown === 'usage'}
      <MoreFilters active={usageFacetCount}>
        <Field label="Provider">
          <Select
            value={usage.provider}
            options={usage.providerOptions}
            placeholder="All Providers"
            aria-label="Filter by provider"
            fill
            onchange={(value) => usage.setProvider(value)}
          />
        </Field>
        <Field label="Tier">
          <Select
            value={usage.tier}
            options={usage.tierOptions}
            placeholder="All Tiers"
            aria-label="Filter by tier"
            fill
            onchange={(value) => usage.setTier(value)}
          />
        </Field>
        <Field label="Model">
          <Select
            value={usage.model}
            options={modelSelectOptions(usage.modelOptions)}
            placeholder="All Models"
            aria-label="Filter by model"
            fill
            onchange={(value) => usage.setModel(value)}
          />
        </Field>
      </MoreFilters>
    {/if}

    {#snippet end()}
      {#if f.hasActiveSharedFilters}
        <Button variant="ghost" size="sm" onclick={() => f.clearSharedFilters()}>Clear</Button>
      {/if}
      <Button variant="neutral" size="sm" onclick={refreshActive}>Refresh</Button>
      {#if canExport}
        <Button variant="neutral" size="sm" onclick={exportActive}>Export CSV</Button>
      {/if}
    {/snippet}
  </FilterBar>

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
