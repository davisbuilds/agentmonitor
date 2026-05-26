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
  import { getLiveSettings, initializeLiveSettings } from './lib/stores/live.svelte';
  import { connectSSE, disconnectSSE } from './lib/stores/sse';
  import ConnectionStatus from './lib/components/monitor/ConnectionStatus.svelte';
  import FilterBar from './lib/components/monitor/FilterBar.svelte';
  import QuotaPill from './lib/components/monitor/QuotaPill.svelte';
  import MonitorPage from './lib/components/monitor/MonitorPage.svelte';
  import LivePage from './lib/components/live/LivePage.svelte';
  import SessionsPage from './lib/components/sessions/SessionsPage.svelte';
  import PinnedPage from './lib/components/pinned/PinnedPage.svelte';
  import SearchPage from './lib/components/search/SearchPage.svelte';
  import CommandPalette from './lib/components/command-palette/CommandPalette.svelte';
  import AnalyticsShell from './lib/components/analytics/AnalyticsShell.svelte';

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

  onMount(() => {
    window.addEventListener('keydown', handleGlobalKeydown);

    void (async () => {
      await initializeLiveSettings();
      if (!getLiveSettings().enabled && getTab() === 'live') {
        setTab('monitor');
      }
      connectSSE();
    })();

    return () => {
      window.removeEventListener('keydown', handleGlobalKeydown);
      disconnectSSE();
    };
  });
</script>

<div class="min-h-full h-screen flex flex-col bg-canvas text-text">
  <!-- Command bar: wordmark · tabs · quota · search · connection -->
  <header class="flex h-14 shrink-0 items-center gap-4 border-b border-line px-4 sm:px-6">
    <div class="flex min-w-0 flex-1 items-center gap-5">
      <h1 class="shrink-0 text-h3 font-semibold tracking-tight">AgentMonitor</h1>
      <nav class="flex min-w-0 items-center gap-1 overflow-x-auto">
        {#each tabs as t}
          <button
            class="shrink-0 rounded-sm px-3 py-1.5 text-meta transition-colors {tab === t.id ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface hover:text-text'}"
            onclick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        {/each}
      </nav>
    </div>
    <div class="flex shrink-0 items-center gap-3">
      <QuotaPill />
      <button
        type="button"
        aria-label="Jump to session or transcript"
        title="Jump to session or transcript (Cmd/Ctrl+K)"
        class="rounded-sm border border-line bg-surface p-2 text-text-muted transition-colors hover:border-line-strong hover:text-text"
        onclick={() => openCommandPalette()}
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="m21 21-4.35-4.35m1.35-5.65a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <ConnectionStatus />
    </div>
  </header>

  <!-- Contextual sub-bar (only on tabs that filter) -->
  {#if tab === 'monitor'}
    <div class="border-b border-line px-4 sm:px-6 py-2">
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
    <AnalyticsShell />
  {:else if tab === 'search'}
    <SearchPage />
  {/if}

  {#if commandPaletteOpen}
    <CommandPalette />
  {/if}
</div>
