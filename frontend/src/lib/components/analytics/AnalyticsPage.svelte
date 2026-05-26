<script lang="ts">
  import { onMount } from 'svelte';
  import { analytics } from '../../stores/analytics.svelte';
  import ActiveFilters from './ActiveFilters.svelte';
  import SummaryCards from './SummaryCards.svelte';
  import ActivityTimeline from './ActivityTimeline.svelte';
  import SkillUsageTimeline from './SkillUsageTimeline.svelte';
  import ProjectBreakdown from './ProjectBreakdown.svelte';
  import ToolUsage from './ToolUsage.svelte';
  import HourOfWeekHeatmap from './HourOfWeekHeatmap.svelte';
  import TopSessions from './TopSessions.svelte';
  import VelocityMetrics from './VelocityMetrics.svelte';
  import AgentComparison from './AgentComparison.svelte';

  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  const banner = $derived.by(() => {
    const summary = analytics.coverage.summary;
    const tools = analytics.coverage.tools;
    if (!summary) return null;

    if (tools && tools.excluded_sessions > 0) {
      return {
        tone: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
        title: 'Analytics is capability-aware.',
        body: `${summary.included_sessions} matching sessions are included in all-session metrics, but ${tools.excluded_sessions} summary-only session${tools.excluded_sessions === 1 ? '' : 's'} are excluded from tool analytics.`,
      };
    }

    return {
      tone: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
      title: 'Analytics reflects session capability coverage.',
      body: summary.note,
    };
  });

  onMount(() => {
    void analytics.initialize();
    const timer = window.setInterval(() => {
      void analytics.fetchAll();
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      analytics.dispose();
    };
  });
</script>

<main class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
  <ActiveFilters />

  {#if banner}
    <div class={`rounded-xl border px-4 py-3 text-sm ${banner.tone}`}>
      <div class="font-medium">{banner.title}</div>
      <p class="mt-1 text-xs text-gray-300">{banner.body}</p>
    </div>
  {/if}

  <SummaryCards />

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
    <div class="space-y-4 xl:col-span-7">
      <ActivityTimeline />
      <SkillUsageTimeline />
      <ProjectBreakdown />
      <HourOfWeekHeatmap />
      <VelocityMetrics />
    </div>

    <div class="space-y-4 xl:col-span-5">
      <TopSessions />
      <ToolUsage />
      <AgentComparison />
    </div>
  </div>
</main>
