<script lang="ts">
  import { onMount } from 'svelte';
  import { analytics } from '../../stores/analytics.svelte';
  import ActiveFilters from './ActiveFilters.svelte';
  import SummaryCards from './SummaryCards.svelte';
  import ActivityTimeline from './ActivityTimeline.svelte';
  import SkillUsageTimeline from './SkillUsageTimeline.svelte';
  import SkillConsultationInsights from './SkillConsultationInsights.svelte';
  import ProjectBreakdown from './ProjectBreakdown.svelte';
  import ToolUsage from './ToolUsage.svelte';
  import HourOfWeekHeatmap from './HourOfWeekHeatmap.svelte';
  import TopSessions from './TopSessions.svelte';
  import VelocityMetrics from './VelocityMetrics.svelte';
  import AgentComparison from './AgentComparison.svelte';

  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;


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


  <SummaryCards />

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
    <div class="space-y-4 xl:col-span-7">
      <ActivityTimeline />
      <SkillUsageTimeline />
      <SkillConsultationInsights />
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
