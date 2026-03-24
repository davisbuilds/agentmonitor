<script lang="ts">
  import { onMount } from 'svelte';
  import { getTab, setTab, type Tab } from './lib/stores/router.svelte';
  import { setFilterOptions } from './lib/stores/monitor.svelte';
  import { connectSSE, disconnectSSE } from './lib/stores/sse';
  import { fetchFilterOptions } from './lib/api/client';
  import StatsBar from './lib/components/monitor/StatsBar.svelte';
  import ConnectionStatus from './lib/components/monitor/ConnectionStatus.svelte';
  import FilterBar from './lib/components/monitor/FilterBar.svelte';
  import UsageMonitor from './lib/components/monitor/UsageMonitor.svelte';
  import MonitorPage from './lib/components/monitor/MonitorPage.svelte';
  import LivePage from './lib/components/live/LivePage.svelte';
  import SessionsPage from './lib/components/sessions/SessionsPage.svelte';
  import SearchPage from './lib/components/search/SearchPage.svelte';
  import AnalyticsPage from './lib/components/analytics/AnalyticsPage.svelte';

  const tab = $derived(getTab());

  let monitorPage = $state<MonitorPage>();

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'monitor', label: 'Monitor' },
    { id: 'live', label: 'Live' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'search', label: 'Search' },
  ];

  async function handleFilterChange(filters: Record<string, string>) {
    if (monitorPage) {
      await monitorPage.reload(filters);
    }
  }

  onMount(async () => {
    // Load filter options
    try {
      const options = await fetchFilterOptions();
      setFilterOptions(options);
    } catch {
      // Filter options may not be available
    }

    // Connect SSE
    connectSSE();

    return () => {
      disconnectSSE();
    };
  });
</script>

<div class="min-h-full h-screen flex flex-col">
  <!-- Usage Monitor -->
  <UsageMonitor />

  <!-- Header -->
  <header class="border-b border-gray-800 px-4 sm:px-6 py-3 flex items-center justify-between shrink-0">
    <div class="flex items-center gap-4 sm:gap-6 flex-wrap">
      <h1 class="text-lg font-bold tracking-tight">AgentMonitor</h1>
      <StatsBar />
    </div>
    <ConnectionStatus />
  </header>

  <!-- Tab Bar -->
  <nav class="border-b border-gray-800 px-4 sm:px-6">
    <div class="flex items-center gap-0">
      {#each tabs as t}
        <button
          class="px-4 py-2 text-sm transition-colors border-b-2 {tab === t.id ? 'text-white border-blue-500' : 'text-gray-400 border-transparent hover:text-gray-200'}"
          onclick={() => setTab(t.id)}
        >
          {t.label}
        </button>
      {/each}
    </div>
  </nav>

  <!-- Filter Bar (Monitor tab only) -->
  {#if tab === 'monitor'}
    <div class="border-b border-gray-800 px-4 sm:px-6 py-2">
      <FilterBar onchange={handleFilterChange} />
    </div>
  {/if}

  <!-- Tab Content -->
  {#if tab === 'monitor'}
    <MonitorPage bind:this={monitorPage} onfilterchange={handleFilterChange} />
  {:else if tab === 'live'}
    <LivePage />
  {:else if tab === 'sessions'}
    <SessionsPage />
  {:else if tab === 'analytics'}
    <AnalyticsPage />
  {:else if tab === 'search'}
    <SearchPage />
  {/if}
</div>
