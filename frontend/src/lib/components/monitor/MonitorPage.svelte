<script lang="ts">
  import { onMount } from 'svelte';
  import AgentCards from './AgentCards.svelte';
  import EventFeed from './EventFeed.svelte';
  import CostDashboard from './CostDashboard.svelte';
  import ToolAnalytics from './ToolAnalytics.svelte';
  import SessionDetail from './SessionDetail.svelte';
  import {
    setEvents,
    setSessions,
    setStats,
    setCostData,
    setToolStats,
    setQuotaMonitor,
    getFilters,
    getCostWindow,
    getFilterOptions,
    setFilterOptions,
  } from '../../stores/monitor.svelte';
  import { fetchStats, fetchEvents, fetchSessions, fetchCostData, fetchToolStats, fetchFilterOptions } from '../../api/client';
  import { buildCostFilters } from '../../monitor-analytics';

  interface Props {
    onfilterchange: (filters: Record<string, string>) => void;
  }
  let { onfilterchange }: Props = $props();

  async function loadAnalytics(filters: Record<string, string> = {}) {
    const analyticsResults = await Promise.allSettled([
      fetchCostData(buildCostFilters(filters, getCostWindow())).then(setCostData),
      fetchToolStats(filters).then(setToolStats),
    ]);
    for (const result of analyticsResults) {
      if (result.status === 'rejected') {
        console.error('Failed to load monitor analytics:', result.reason);
      }
    }
  }

  export async function reload(filters: Record<string, string> = {}) {
    const sessionsParams: Record<string, string> = { limit: '0', exclude_status: 'ended' };
    if (filters.agent_type) sessionsParams.agent_type = filters.agent_type;

    try {
      const [statsData, eventsData, sessionsData] = await Promise.all([
        fetchStats(filters),
        fetchEvents(filters),
        fetchSessions(sessionsParams),
      ]);
      setStats(statsData);
      setQuotaMonitor(statsData.quota_monitor || statsData.usage_monitor || []);
      setEvents(eventsData.events || []);
      setSessions(sessionsData.sessions || []);
    } catch (err) {
      console.error('Failed to load monitor data:', err);
    }

    await loadAnalytics(filters);
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
</script>

<main class="flex-1 min-h-0 overflow-y-auto flex flex-col p-4 sm:p-6 gap-6">
  <section>
    <AgentCards />
  </section>

  <section>
    <CostDashboard onwindowchange={() => void loadAnalytics(getFilters())} />
  </section>

  <section>
    <ToolAnalytics />
  </section>

  <EventFeed />
</main>

<SessionDetail />
