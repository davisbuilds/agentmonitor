<script lang="ts">
  import { onMount } from 'svelte';
  import { usage } from '../../stores/usage.svelte';
  import UsageCoverageBanner from './UsageCoverageBanner.svelte';
  import UsageSummaryCards from './UsageSummaryCards.svelte';
  import UsageTimeline from './UsageTimeline.svelte';
  import UsageBreakdownTable from './UsageBreakdownTable.svelte';
  import UsageTopSessions from './UsageTopSessions.svelte';

  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  function formatAgentLabel(agent: string): string {
    return agent === 'claude_code' ? 'claude' : agent;
  }

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
  <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-950/50 px-4 py-3">
    <div class="flex flex-wrap items-center gap-2">
      <input
        type="date"
        class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
        bind:value={usage.from}
        onchange={(event) => usage.setDateRange((event.currentTarget as HTMLInputElement).value, usage.to)}
      />
      <span class="text-sm text-gray-500">to</span>
      <input
        type="date"
        class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
        bind:value={usage.to}
        onchange={(event) => usage.setDateRange(usage.from, (event.currentTarget as HTMLInputElement).value)}
      />

      <select
        class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
        bind:value={usage.project}
        onchange={(event) => usage.setProject((event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">All Projects</option>
        {#each usage.projectOptions as project}
          <option value={project}>{project}</option>
        {/each}
      </select>

      <select
        class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
        bind:value={usage.agent}
        onchange={(event) => usage.setAgent((event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">All Agents</option>
        {#each usage.agentOptions as agent}
          <option value={agent}>{formatAgentLabel(agent)}</option>
        {/each}
      </select>

      <div class="hidden items-center gap-2 md:flex">
        <button class="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-white" onclick={() => usage.applyQuickRange(7)}>7d</button>
        <button class="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-white" onclick={() => usage.applyQuickRange(30)}>30d</button>
        <button class="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-white" onclick={() => usage.applyQuickRange(90)}>90d</button>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <button class="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-500 hover:text-white" onclick={() => usage.clearAllFilters()}>
        Reset
      </button>
      <button class="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-500 hover:text-white" onclick={() => usage.fetchAll()}>
        Refresh
      </button>
      <button class="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500" onclick={() => usage.exportCsv()}>
        Export CSV
      </button>
    </div>
  </div>

  <UsageCoverageBanner />
  <UsageSummaryCards />

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
    <div class="xl:col-span-7">
      <UsageTimeline />
    </div>
    <div class="xl:col-span-5">
      <UsageTopSessions />
    </div>
    <div class="xl:col-span-4">
      <UsageBreakdownTable
        title="By Project"
        kind="project"
        rows={usage.projects}
        loading={usage.loading.projects}
        error={usage.errors.projects}
      />
    </div>
    <div class="xl:col-span-4">
      <UsageBreakdownTable
        title="By Model"
        kind="model"
        rows={usage.models}
        loading={usage.loading.models}
        error={usage.errors.models}
      />
    </div>
    <div class="xl:col-span-4">
      <UsageBreakdownTable
        title="By Agent"
        kind="agent"
        rows={usage.agents}
        loading={usage.loading.agents}
        error={usage.errors.agents}
      />
    </div>
  </div>
</main>
