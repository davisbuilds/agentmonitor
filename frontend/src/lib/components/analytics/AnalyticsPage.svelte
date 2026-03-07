<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchAnalyticsSummary,
    fetchAnalyticsActivity,
    fetchAnalyticsProjects,
    fetchAnalyticsTools,
    type AnalyticsSummary,
    type ActivityDataPoint,
    type ProjectBreakdown,
    type ToolUsageStat,
  } from '../../api/client';
  import { formatNumber } from '../../format';

  let summary = $state<AnalyticsSummary | null>(null);
  let activity = $state<ActivityDataPoint[]>([]);
  let projectBreakdowns = $state<ProjectBreakdown[]>([]);
  let toolUsage = $state<ToolUsageStat[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Compute max values for bar chart scaling
  let maxMessages = $derived(Math.max(...activity.map(a => a.messages), 1));
  let maxProjectMessages = $derived(Math.max(...projectBreakdowns.map(p => p.message_count), 1));
  let maxToolCount = $derived(Math.max(...toolUsage.map(t => t.count), 1));

  onMount(async () => {
    try {
      const [s, a, p, t] = await Promise.all([
        fetchAnalyticsSummary(),
        fetchAnalyticsActivity(),
        fetchAnalyticsProjects(),
        fetchAnalyticsTools(),
      ]);
      summary = s;
      activity = a.data;
      projectBreakdowns = p.data;
      toolUsage = t.data;
    } catch (err) {
      console.error('Failed to load analytics:', err);
      error = 'Failed to load analytics. Check that the server is running.';
    } finally {
      loading = false;
    }
  });
</script>

<main class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
  {#if loading}
    <div class="text-center py-24 text-gray-500 text-sm">Loading analytics...</div>
  {:else if error}
    <div class="text-center py-24 text-red-400 text-sm">{error}</div>
  {:else}
    <!-- Summary Cards -->
    {#if summary}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div class="bg-gray-900/50 border border-gray-800 rounded p-3">
          <div class="text-xs text-gray-500 mb-1">Total Sessions</div>
          <div class="text-lg font-bold text-gray-200">{formatNumber(summary.total_sessions)}</div>
        </div>
        <div class="bg-gray-900/50 border border-gray-800 rounded p-3">
          <div class="text-xs text-gray-500 mb-1">Total Messages</div>
          <div class="text-lg font-bold text-gray-200">{formatNumber(summary.total_messages)}</div>
        </div>
        <div class="bg-gray-900/50 border border-gray-800 rounded p-3">
          <div class="text-xs text-gray-500 mb-1">Avg Sessions/Day</div>
          <div class="text-lg font-bold text-gray-200">{summary.daily_average_sessions.toFixed(1)}</div>
        </div>
        <div class="bg-gray-900/50 border border-gray-800 rounded p-3">
          <div class="text-xs text-gray-500 mb-1">Avg Messages/Day</div>
          <div class="text-lg font-bold text-gray-200">{summary.daily_average_messages.toFixed(1)}</div>
        </div>
      </div>
    {/if}

    <!-- Activity Chart (simple bar chart) -->
    {#if activity.length > 0}
      <section>
        <h3 class="text-sm font-semibold text-gray-300 mb-3">Activity (Last 30 Days)</h3>
        <div class="bg-gray-900/50 border border-gray-800 rounded p-3">
          <div class="flex items-end gap-[2px] h-32">
            {#each activity as day}
              <div
                class="flex-1 bg-blue-500/60 hover:bg-blue-500/80 transition-colors rounded-t relative group"
                style="height: {(day.messages / maxMessages) * 100}%"
              >
                <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-gray-800 text-xs text-gray-300 px-2 py-1 rounded whitespace-nowrap z-10">
                  {day.date}: {day.messages} msgs, {day.sessions} sessions
                </div>
              </div>
            {/each}
          </div>
          <div class="flex justify-between mt-1 text-xs text-gray-600">
            {#if activity.length > 0}
              <span>{activity[0].date}</span>
              <span>{activity[activity.length - 1].date}</span>
            {/if}
          </div>
        </div>
      </section>
    {/if}

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <!-- Projects Breakdown -->
      {#if projectBreakdowns.length > 0}
        <section>
          <h3 class="text-sm font-semibold text-gray-300 mb-3">Projects</h3>
          <div class="bg-gray-900/50 border border-gray-800 rounded p-3 space-y-2">
            {#each projectBreakdowns as proj}
              <div>
                <div class="flex justify-between text-xs mb-1">
                  <span class="text-gray-300">{proj.project || '(unknown)'}</span>
                  <span class="text-gray-500">{proj.session_count} sessions · {formatNumber(proj.message_count)} msgs</span>
                </div>
                <div class="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-green-500/60 rounded-full"
                    style="width: {(proj.message_count / maxProjectMessages) * 100}%"
                  ></div>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Tool Usage -->
      {#if toolUsage.length > 0}
        <section>
          <h3 class="text-sm font-semibold text-gray-300 mb-3">Tool Usage</h3>
          <div class="bg-gray-900/50 border border-gray-800 rounded p-3 space-y-2">
            {#each toolUsage.slice(0, 15) as tool}
              <div>
                <div class="flex justify-between text-xs mb-1">
                  <span class="text-gray-300 font-mono">{tool.tool_name}</span>
                  <span class="text-gray-500">{formatNumber(tool.count)}</span>
                </div>
                <div class="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-amber-500/60 rounded-full"
                    style="width: {(tool.count / maxToolCount) * 100}%"
                  ></div>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    </div>

    {#if !summary && activity.length === 0 && projectBreakdowns.length === 0}
      <div class="text-center py-16 text-gray-500">
        <p class="text-sm">No analytics data yet.</p>
        <p class="text-xs mt-1">Data populates as session files are discovered and parsed.</p>
      </div>
    {/if}
  {/if}
</main>
