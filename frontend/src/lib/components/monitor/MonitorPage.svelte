<script lang="ts">
  import { onMount } from 'svelte';
  import AgentCards from './AgentCards.svelte';
  import MonitorStream from './MonitorStream.svelte';
  import StatsBar from './StatsBar.svelte';
  import {
    setEvents,
    setSessions,
    setStats,
    beginFilteredStatsRead,
    getStats,
    endFilteredStatsRead,
    setCostWindows,
    setQuotaMonitor,
    getFilters,
    setFilters,
    getFilterOptions,
    setFilterOptions,
    getAutoImportSignal,
    getReconnectSignal,
    getStatsRefreshSignal,
    refreshOccupancy,
  } from '../../stores/monitor.svelte';
  import { fetchStats, fetchEvents, fetchMonitorSessions, fetchFilterOptions, fetchUsageSummary, statsParams } from '../../api/client';
  import { monitorCostWindowParams } from '../../monitor-analytics';
  import { getMonitorSessionId } from '../../stores/router.svelte';
  import { FilterBar, Select } from '../ui';
  import { agentName } from '../../format';

  // A card's drill-in (`#monitor?session=…`): its live stream, or its events when it has none.
  const followedSessionId = $derived(getMonitorSessionId());

  // Monitor filters by agent alone: it is the one filter every read here
  // honors (the stats, the cards, their recent events and the cost windows).
  const agentFilter = $derived(getFilters().agent_type ?? '');
  const agentOptions = $derived(getFilterOptions().agent_types.map(agent => ({ value: agent, label: agentName(agent) })));
  function setAgentFilter(agent: string): void {
    const next: Record<string, string> = agent ? { agent_type: agent } : {};
    setFilters(next);
    void reload(next);
  }

  // Today's and the last 30 days' cost come from the Usage API, with the window
  // Usage's 30D range uses, so the Monitor and Usage show the same figures.
  // Each read is synchronous SQLite work on the server, so they run in turn,
  // and only the latest request's figures are kept.
  let costWindowsRequest = 0;
  let lastCostWindowsAt = 0;
  async function loadCostWindows(filters: Record<string, string> = {}) {
    const request = ++costWindowsRequest;
    lastCostWindowsAt = Date.now();
    try {
      const windows = monitorCostWindowParams(filters);
      const today = await fetchUsageSummary(windows.today);
      if (request !== costWindowsRequest) return;
      const last30Days = await fetchUsageSummary(windows.last30Days);
      if (request !== costWindowsRequest) return;
      setCostWindows({ today: today.total_cost_usd, last30Days: last30Days.total_cost_usd });
    } catch (error) {
      console.error('Failed to load monitor cost windows:', error);
    }
  }

  async function reload(filters: Record<string, string> = {}) {
    const sessionsParams: Record<string, string> = { limit: '0', exclude_status: 'ended' };
    if (filters.agent_type) sessionsParams.agent_type = filters.agent_type;

    try {
      const [statsData, eventsData, sessionsData] = await Promise.all([
        fetchStats(filters),
        fetchEvents(filters),
        fetchMonitorSessions(sessionsParams),
      ]);
      setStats(statsData);
      setQuotaMonitor(statsData.quota_monitor || statsData.usage_monitor || []);
      setEvents(eventsData.events || []);
      setSessions(sessionsData.sessions || []);
      void refreshOccupancy();
    } catch (err) {
      console.error('Failed to load monitor data:', err);
    }

    await loadCostWindows(filters);
  }

  async function loadMonitorFilterOptions() {
    const options = getFilterOptions();
    if (
      options.agent_types.length > 0
      || options.event_types.length > 0
      || options.tool_names.length > 0
      || options.models.length > 0
      || options.projects.length > 0
      || options.branches.length > 0
      || options.sources.length > 0
    ) {
      return;
    }

    try {
      setFilterOptions(await fetchFilterOptions());
    } catch {
      // Monitor data still renders without dropdown metadata.
    }
  }

  onMount(() => {
    void loadMonitorFilterOptions();
    reload(getFilters());
  });

  // Refetch when the server reports an auto-import (new events landed). This is
  // how importer-derived fields like session invocation `mode` reach an already
  // open Monitor — the live SSE stream (hooks/OTEL) does not carry them. Guarded
  // against the effect's initial run so mount doesn't double-load.
  let lastAutoImportSignal = getAutoImportSignal();
  $effect(() => {
    const signal = getAutoImportSignal();
    if (signal !== lastAutoImportSignal) {
      lastAutoImportSignal = signal;
      void reload(getFilters());
    }
  });

  // Under an agent or start-time filter the store drops the unfiltered SSE
  // stats snapshot and asks for this instead. A filtered read is synchronous
  // SQLite work that can take seconds on a large store, so never overlap one
  // and take at most one per interval; live events keep the bar current in
  // between. A response for a filter that has since changed is discarded.
  const FILTERED_STATS_REFRESH_MS = 30_000;
  let lastStatsRefreshSignal = getStatsRefreshSignal();
  let filteredStatsInFlight = false;
  let lastFilteredStatsAt = 0;
  $effect(() => {
    const signal = getStatsRefreshSignal();
    if (signal === lastStatsRefreshSignal) return;
    lastStatsRefreshSignal = signal;
    if (filteredStatsInFlight || Date.now() - lastFilteredStatsAt < FILTERED_STATS_REFRESH_MS) return;
    const requested = getFilters();
    filteredStatsInFlight = true;
    lastFilteredStatsAt = Date.now();
    beginFilteredStatsRead();
    fetchStats(requested)
      .then((next) => {
        const current = JSON.stringify(statsParams(getFilters())) === JSON.stringify(statsParams(requested));
        endFilteredStatsRead(current ? next : null);
      })
      .catch((err) => {
        endFilteredStatsRead(null);
        console.error('Failed to refresh filtered monitor stats:', err);
      })
      .finally(() => { filteredStatsInFlight = false; });
  });

  // Live events move the all-time cost in the stats snapshot as they land; take
  // that as the cue to re-read the windowed figures, at most once per interval.
  const COST_WINDOWS_REFRESH_MS = 30_000;
  let lastCostSeen: number | null = null;
  $effect(() => {
    const cost = getStats().total_cost_usd;
    if (lastCostSeen === null) {
      lastCostSeen = cost;
      return;
    }
    if (cost === lastCostSeen) return;
    lastCostSeen = cost;
    if (Date.now() - lastCostWindowsAt < COST_WINDOWS_REFRESH_MS) return;
    void loadCostWindows(getFilters());
  });

  // Refetch after an SSE reconnect: the v1 stream has no replay, so events that
  // landed while the connection was dropped (e.g. laptop sleep) never reached the
  // incremental store. Guarded against the initial run so mount doesn't double-load.
  let lastReconnectSignal = getReconnectSignal();
  $effect(() => {
    const signal = getReconnectSignal();
    if (signal !== lastReconnectSignal) {
      lastReconnectSignal = signal;
      void reload(getFilters());
    }
  });
</script>

<FilterBar>
  <Select
    value={agentFilter}
    options={agentOptions}
    placeholder="All Agents"
    aria-label="Filter by agent"
    onchange={setAgentFilter}
  />
  <div class="mx-1 h-5 w-px bg-line" aria-hidden="true"></div>
  <StatsBar />
</FilterBar>

{#if followedSessionId}
  <main class="flex-1 min-h-0 overflow-y-auto flex flex-col p-4 sm:p-6 gap-4 xl:overflow-hidden">
    <MonitorStream sessionId={followedSessionId} />
  </main>
{:else}
  <main class="flex-1 min-h-0 overflow-y-auto flex flex-col p-4 sm:p-6">
    <AgentCards />
  </main>
{/if}
