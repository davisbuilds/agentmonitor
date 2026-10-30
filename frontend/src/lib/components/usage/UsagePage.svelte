<script lang="ts">
  import { onMount } from 'svelte';
  import { usage } from '../../stores/usage.svelte';
  import UsageUnpricedWarning from './UsageUnpricedWarning.svelte';
  import UsageSummaryCards from './UsageSummaryCards.svelte';
  import UsageBreakdown from './UsageBreakdown.svelte';
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
  <UsageUnpricedWarning />
  <UsageSummaryCards />

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
    <div class="xl:col-span-7">
      <UsageTopModels />
    </div>
    <div class="xl:col-span-5">
      <UsageTopSessions />
    </div>

    <div class="xl:col-span-12">
      <UsageBreakdown />
    </div>
  </div>
</main>
