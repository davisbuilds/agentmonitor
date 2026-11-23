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
  import { latestRequest } from '../../stores/latest-request';
  import { FilterBar, Select } from '../ui';
  import { agentName } from '../../format';

  const followedSessionId = $derived(getMonitorSessionId());

  // WHY: Expose only the agent filter because it is the sole filter every Monitor read honors.
  const agentFilter = $derived(getFilters().agent_type ?? '');
  const agentOptions = $derived(getFilterOptions().agent_types.map(agent => ({ value: agent, label: agentName(agent) })));
  function setAgentFilter(agent: string): void {
    const next: Record<string, string> = agent ? { agent_type: agent } : {};
    setFilters(next);
    void reload(next);
  }

  // WHY: Use the same date windows as Usage so both views agree. Serialize the reads because they do
  // synchronous SQLite work.
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

  // WHY: Filter changes, reconnects, or imports can overlap. Only the latest reload may write the
  // visible snapshot.
  const reloads = latestRequest();
  async function reload(filters: Record<string, string> = {}) {
    const isCurrent = reloads.begin();
    const sessionsParams: Record<string, string> = { limit: '0', exclude_status: 'ended' };
    if (filters.agent_type) sessionsParams.agent_type = filters.agent_type;

    try {
      const [statsData, eventsData, sessionsData] = await Promise.all([
        fetchStats(filters),
        fetchEvents(filters),
        fetchMonitorSessions(sessionsParams),
      ]);
      if (!isCurrent()) return;
      setStats(statsData);
      setQuotaMonitor(statsData.quota_monitor || statsData.usage_monitor || []);
      setEvents(eventsData.events || []);
      setSessions(sessionsData.sessions || []);
      void refreshOccupancy();
    } catch (err) {
      if (!isCurrent()) return;
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
      // WHY: Keep Monitor usable when its optional filter metadata request fails.
    }
  }

  onMount(() => {
    void loadMonitorFilterOptions();
    reload(getFilters());
  });

  // WHY: Reload imported session metadata because live hook and OTEL events omit it. Skip the initial
  // effect run to avoid a duplicate mounted load.
  let lastAutoImportSignal = getAutoImportSignal();
  $effect(() => {
    const signal = getAutoImportSignal();
    if (signal !== lastAutoImportSignal) {
      lastAutoImportSignal = signal;
      void reload(getFilters());
    }
  });

  // WHY: Serialize and throttle filtered statistics because synchronous SQLite reads can block a large
  // store. The stream keeps recent events current between reads.
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

  // WHY: Use a changing live total to refresh the cost windows, with a rate cap on the synchronous
  // reads.
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

  // WHY: Reconnects leave a gap because the SSE endpoint has no replay. Reload the snapshot once after
  // reconnect.
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
