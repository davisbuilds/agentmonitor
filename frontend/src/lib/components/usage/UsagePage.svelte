<script lang="ts">
  import { onMount } from 'svelte';
  import { usage } from '../../stores/usage.svelte';
  import { Select } from '../ui';
  import UsageCoverageBanner from './UsageCoverageBanner.svelte';
  import UsageSummaryCards from './UsageSummaryCards.svelte';
  import UsageTimeline from './UsageTimeline.svelte';
  import UsageBreakdownTable from './UsageBreakdownTable.svelte';
  import UsageTopModels from './UsageTopModels.svelte';
  import UsageTopSessions from './UsageTopSessions.svelte';

  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  onMount(() => {
    void usage.initialize();
    const timer = window.setInterval(() => {
      void usage.fetchAll();
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      usage.dispose();
    };
  });
</script>

<main class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
  <!-- Cost-specific facets; shared date/project/agent live in the Analytics bar. -->
  <div class="flex flex-wrap items-center gap-2">
    <span class="text-meta uppercase tracking-wide text-text-faint">Cost facets</span>
    <Select
      value={usage.provider}
      options={usage.providerOptions}
      placeholder="All Providers"
      aria-label="Filter by provider"
      onchange={(value) => usage.setProvider(value)}
    />
    <Select
      value={usage.tier}
      options={usage.tierOptions}
      placeholder="All Tiers"
      aria-label="Filter by tier"
      onchange={(value) => usage.setTier(value)}
    />
    <Select
      value={usage.model}
      options={usage.modelOptions}
      placeholder="All Models"
      aria-label="Filter by model"
      onchange={(value) => usage.setModel(value)}
    />
  </div>

  <UsageCoverageBanner />
  <UsageSummaryCards />

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
    <div class="xl:col-span-7">
      <UsageTimeline />
    </div>
    <div class="xl:col-span-5">
      <UsageTopSessions />
    </div>

    <!-- Chart and its table sit together: the table is the chart's accessible view. -->
    <div class="xl:col-span-7">
      <UsageTopModels />
    </div>
    <div class="xl:col-span-5">
      <UsageBreakdownTable
        title="By Model"
        kind="model"
        rows={usage.models}
        loading={usage.loading.models}
        error={usage.errors.models}
      />
    </div>

    <div class="xl:col-span-4">
      <UsageBreakdownTable
        title="By Project"
        kind="project"
        rows={usage.projects}
        loading={usage.loading.projects}
        error={usage.errors.projects}
      />
    </div>
    <div class="xl:col-span-4">
      <UsageBreakdownTable
        title="By Tier"
        kind="tier"
        rows={usage.tiers}
        loading={usage.loading.tiers}
        error={usage.errors.tiers}
      />
    </div>
    <div class="xl:col-span-4">
      <UsageBreakdownTable
        title="By Agent"
        kind="agent"
        rows={usage.agents}
        loading={usage.loading.agents}
        error={usage.errors.agents}
      />
    </div>
  </div>
</main>
