<script lang="ts">
  import { onMount } from 'svelte';
  import { insights } from '../../stores/insights.svelte';

  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  function formatKind(kind: string): string {
    if (kind === 'workflow') return 'Workflow';
    if (kind === 'usage') return 'Usage';
    return 'Overview';
  }

  function formatAgent(agent: string | null): string {
    if (!agent) return 'All agents';
    return agent === 'claude_code' ? 'claude' : agent;
  }

  function formatCost(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  function formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
  }

  function formatDateTime(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString();
  }

  function formatProvider(provider: string): string {
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'gemini') return 'Gemini';
    return 'OpenAI';
  }

  onMount(() => {
    void insights.initialize();
    const timer = window.setInterval(() => {
      void insights.load();
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  });
</script>

<main class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
  <div class="rounded-xl border border-gray-800 bg-gray-950/50 px-4 py-3">
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <select
          class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
          bind:value={insights.kind}
          onchange={(event) => insights.setKind((event.currentTarget as HTMLSelectElement).value as 'overview' | 'workflow' | 'usage')}
        >
          <option value="overview">Overview</option>
          <option value="workflow">Workflow</option>
          <option value="usage">Usage</option>
        </select>

        <input
          type="date"
          class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
          bind:value={insights.from}
          onchange={(event) => insights.setDateRange((event.currentTarget as HTMLInputElement).value, insights.to)}
        />
        <span class="text-sm text-gray-500">to</span>
        <input
          type="date"
          class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
          bind:value={insights.to}
          onchange={(event) => insights.setDateRange(insights.from, (event.currentTarget as HTMLInputElement).value)}
        />

        <select
          class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
          bind:value={insights.project}
          onchange={(event) => insights.setProject((event.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">All Projects</option>
          {#each insights.projectOptions as project}
            <option value={project}>{project}</option>
          {/each}
        </select>

        <select
          class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
          bind:value={insights.agent}
          onchange={(event) => insights.setAgent((event.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">All Agents</option>
          {#each insights.agentOptions as agent}
            <option value={agent}>{formatAgent(agent)}</option>
          {/each}
        </select>

        <div class="hidden items-center gap-2 md:flex">
          <button class="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-white" onclick={() => insights.applyQuickRange(7)}>7d</button>
          <button class="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-white" onclick={() => insights.applyQuickRange(30)}>30d</button>
          <button class="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-white" onclick={() => insights.applyQuickRange(90)}>90d</button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <select
          class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
          bind:value={insights.provider}
          onchange={(event) => insights.setProvider((event.currentTarget as HTMLSelectElement).value as 'openai' | 'anthropic' | 'gemini')}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Gemini</option>
        </select>

        <input
          type="text"
          class="min-w-[14rem] rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-300"
          placeholder="Model"
          bind:value={insights.model}
          oninput={(event) => insights.setModel((event.currentTarget as HTMLInputElement).value)}
        />
      </div>

      <textarea
        class="min-h-24 rounded border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-300"
        placeholder="Optional steering, e.g. focus on cost hotspots or workflow bottlenecks."
        bind:value={insights.prompt}
        oninput={(event) => insights.setPrompt((event.currentTarget as HTMLTextAreaElement).value)}
      ></textarea>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="text-xs text-gray-500">
          Provider: <span class="text-gray-300">{formatProvider(insights.provider)}</span>
          <span class="mx-2 text-gray-700">•</span>
          Model: <span class="text-gray-300">{insights.model}</span>
        </div>

        <div class="flex items-center gap-2">
          <button class="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-500 hover:text-white" onclick={() => insights.clearFilters()}>
            Reset
          </button>
          <button class="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-500 hover:text-white" onclick={() => insights.load()}>
            Refresh
          </button>
          <button
            class="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-blue-800"
            onclick={() => insights.generate()}
            disabled={insights.generating || !insights.selectedProviderConfigured}
          >
            {insights.generating ? 'Generating…' : 'Generate Insight'}
          </button>
        </div>
      </div>
    </div>
  </div>

  {#if !insights.selectedProviderConfigured}
    <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
      {formatProvider(insights.provider)} insight generation is not configured. Set the matching provider API key in the environment before generating new insights.
    </div>
  {/if}

  {#if insights.error}
    <div class="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      {insights.error}
    </div>
  {/if}

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
    <section class="rounded-xl border border-gray-800 bg-gray-950/40 xl:col-span-4">
      <div class="border-b border-gray-800 px-4 py-3">
        <div class="text-sm font-semibold text-gray-100">Saved Insights</div>
        <div class="mt-1 text-xs text-gray-500">
          {insights.items.length} insight{insights.items.length === 1 ? '' : 's'} in this slice
        </div>
      </div>

      <div class="max-h-[70vh] overflow-y-auto">
        {#if insights.loading}
          <div class="px-4 py-12 text-center text-sm text-gray-500">Loading insights…</div>
        {:else if insights.items.length === 0}
          <div class="px-4 py-12 text-center text-sm text-gray-500">No saved insights for the current filters.</div>
        {:else}
          <div class="divide-y divide-gray-800">
            {#each insights.items as item}
              <button
                class={`block w-full px-4 py-3 text-left transition hover:bg-gray-900/60 ${insights.selectedId === item.id ? 'bg-gray-900/80' : ''}`}
                onclick={() => insights.select(item.id)}
              >
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <div class="font-medium text-gray-100">{item.title}</div>
                    <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span class="rounded border border-gray-700 px-1.5 py-0.5 text-gray-300">{formatKind(item.kind)}</span>
                      <span>{item.date_from}{item.date_from === item.date_to ? '' : ` → ${item.date_to}`}</span>
                    </div>
                  </div>
                  <div class="shrink-0 text-xs text-gray-500">{formatDateTime(item.created_at)}</div>
                </div>
                <div class="mt-2 text-xs text-gray-400">
                  {item.project || 'All projects'} • {formatAgent(item.agent)}
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </section>

    <section class="rounded-xl border border-gray-800 bg-gray-950/40 xl:col-span-8">
      {#if insights.selected}
        <div class="border-b border-gray-800 px-4 py-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold text-gray-100">{insights.selected.title}</h2>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span class="rounded border border-gray-700 px-1.5 py-0.5 text-gray-300">{formatKind(insights.selected.kind)}</span>
                <span>{insights.selected.date_from}{insights.selected.date_from === insights.selected.date_to ? '' : ` → ${insights.selected.date_to}`}</span>
                <span>{insights.selected.project || 'All projects'}</span>
                <span>{formatAgent(insights.selected.agent)}</span>
                <span>{formatProvider(insights.selected.provider)}</span>
                <span>{insights.selected.model}</span>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <div class="text-xs text-gray-500">{formatDateTime(insights.selected.created_at)}</div>
              <button
                class="rounded border border-red-500/40 px-3 py-1.5 text-sm text-red-200 hover:border-red-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                onclick={() => insights.removeSelected()}
                disabled={insights.deleting}
              >
                {insights.deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 border-b border-gray-800 px-4 py-4 md:grid-cols-4">
          <div class="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2">
            <div class="text-xs uppercase tracking-wide text-gray-500">Sessions</div>
            <div class="mt-1 text-lg font-semibold text-gray-100">{formatNumber(insights.selected.analytics_summary.total_sessions)}</div>
          </div>
          <div class="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2">
            <div class="text-xs uppercase tracking-wide text-gray-500">Messages</div>
            <div class="mt-1 text-lg font-semibold text-gray-100">{formatNumber(insights.selected.analytics_summary.total_messages)}</div>
          </div>
          <div class="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2">
            <div class="text-xs uppercase tracking-wide text-gray-500">Usage Events</div>
            <div class="mt-1 text-lg font-semibold text-gray-100">{formatNumber(insights.selected.usage_summary.total_usage_events)}</div>
          </div>
          <div class="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2">
            <div class="text-xs uppercase tracking-wide text-gray-500">Cost</div>
            <div class="mt-1 text-lg font-semibold text-gray-100">{formatCost(insights.selected.usage_summary.total_cost_usd)}</div>
          </div>
        </div>

        <div class="grid grid-cols-1 gap-3 border-b border-gray-800 px-4 py-4 lg:grid-cols-2">
          <div class="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-3">
            <div class="text-sm font-medium text-sky-200">Analytics Coverage</div>
            <p class="mt-1 text-xs text-gray-300">
              {formatNumber(insights.selected.analytics_coverage.included_sessions)} of {formatNumber(insights.selected.analytics_coverage.matching_sessions)} matching sessions are included. {insights.selected.analytics_coverage.note}
            </p>
          </div>
          <div class="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-3">
            <div class="text-sm font-medium text-emerald-200">Usage Coverage</div>
            <p class="mt-1 text-xs text-gray-300">
              {formatNumber(insights.selected.usage_coverage.usage_events)} of {formatNumber(insights.selected.usage_coverage.matching_events)} matching events carry usage metrics. {insights.selected.usage_coverage.note}
            </p>
          </div>
        </div>

        {#if insights.selected.prompt}
          <div class="border-b border-gray-800 px-4 py-4">
            <div class="text-sm font-medium text-gray-100">Prompt Steering</div>
            <p class="mt-2 text-sm text-gray-300">{insights.selected.prompt}</p>
          </div>
        {/if}

        <div class="px-4 py-4">
          <div class="text-sm font-medium text-gray-100">Insight</div>
          <pre class="mt-3 whitespace-pre-wrap break-words rounded-lg border border-gray-800 bg-gray-950 p-4 text-sm leading-6 text-gray-200">{insights.selected.content}</pre>
        </div>
      {:else}
        <div class="px-4 py-16 text-center text-sm text-gray-500">
          Select a saved insight or generate a new one to inspect it here.
        </div>
      {/if}
    </section>
  </div>
</main>
