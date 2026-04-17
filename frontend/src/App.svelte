<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getTab,
    setTab,
    isCommandPaletteOpen,
    closeCommandPalette,
    toggleCommandPalette,
    openCommandPalette,
    type Tab,
  } from './lib/stores/router.svelte';
  import { setFilterOptions } from './lib/stores/monitor.svelte';
  import { getLiveSettings, initializeLiveSettings } from './lib/stores/live.svelte';
  import { connectSSE, disconnectSSE } from './lib/stores/sse';
  import { fetchFilterOptions } from './lib/api/client';
  import StatsBar from './lib/components/monitor/StatsBar.svelte';
  import ConnectionStatus from './lib/components/monitor/ConnectionStatus.svelte';
  import FilterBar from './lib/components/monitor/FilterBar.svelte';
  import UsageMonitor from './lib/components/monitor/UsageMonitor.svelte';
  import MonitorPage from './lib/components/monitor/MonitorPage.svelte';
  import LivePage from './lib/components/live/LivePage.svelte';
  import SessionsPage from './lib/components/sessions/SessionsPage.svelte';
  import PinnedPage from './lib/components/pinned/PinnedPage.svelte';
  import SearchPage from './lib/components/search/SearchPage.svelte';
  import CommandPalette from './lib/components/command-palette/CommandPalette.svelte';
  import AnalyticsPage from './lib/components/analytics/AnalyticsPage.svelte';
  import UsagePage from './lib/components/usage/UsagePage.svelte';
  import InsightsPage from './lib/components/insights/InsightsPage.svelte';

  const tab = $derived(getTab());
  const commandPaletteOpen = $derived(isCommandPaletteOpen());
  const liveSettings = $derived(getLiveSettings());

  let monitorPage = $state<MonitorPage>();

  const tabs = $derived.by(() => {
    const next: Array<{ id: Tab; label: string }> = [
      { id: 'monitor', label: 'Monitor' },
      { id: 'sessions', label: 'Sessions' },
      { id: 'pinned', label: 'Pinned' },
      { id: 'analytics', label: 'Analytics' },
      { id: 'usage', label: 'Usage' },
      { id: 'insights', label: 'Insights' },
      { id: 'search', label: 'Search' },
    ];
    if (liveSettings.enabled) {
      next.splice(1, 0, { id: 'live', label: 'Live' });
    }
    return next;
  });

  async function handleFilterChange(filters: Record<string, string>) {
    if (monitorPage) {
      await monitorPage.reload(filters);
    }
  }

  function handleGlobalKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      toggleCommandPalette();
      return;
    }

    if (event.key === 'Escape' && isCommandPaletteOpen()) {
      closeCommandPalette();
    }
  }

  onMount(async () => {
    window.addEventListener('keydown', handleGlobalKeydown);

    // Load filter options
    try {
      const options = await fetchFilterOptions();
      setFilterOptions(options);
    } catch {
      // Filter options may not be available
    }

    await initializeLiveSettings();
    if (!getLiveSettings().enabled && getTab() === 'live') {
      setTab('monitor');
    }

    // Connect SSE
    connectSSE();

    return () => {
      window.removeEventListener('keydown', handleGlobalKeydown);
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
    <div class="flex items-center gap-3">
      <button
        type="button"
        class="hidden rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-left text-sm text-gray-300 transition hover:border-gray-600 hover:text-gray-100 sm:flex sm:min-w-[220px] sm:items-center sm:justify-between"
        onclick={() => openCommandPalette()}
      >
        <span>Jump to session or transcript...</span>
        <span class="text-xs text-gray-500">Cmd/Ctrl+K</span>
      </button>
      <ConnectionStatus />
    </div>
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
  {:else if tab === 'pinned'}
    <PinnedPage />
  {:else if tab === 'analytics'}
    <AnalyticsPage />
  {:else if tab === 'usage'}
    <UsagePage />
  {:else if tab === 'insights'}
    <InsightsPage />
  {:else if tab === 'search'}
    <SearchPage />
  {/if}

  {#if commandPaletteOpen}
    <CommandPalette />
  {/if}
</div>
