<script lang="ts">
  import { onMount } from 'svelte';
  import { insights } from '../../stores/insights.svelte';
  import { Badge, Button, Stat } from '../ui';

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
      insights.dispose();
    };
  });
</script>

<main class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
  <div class="rounded-lg border border-line bg-surface px-4 py-3">
    <div class="flex flex-col gap-3">
      <!-- Insight kind + authoring LLM; shared date/project/agent live in the Analytics bar. -->
      <div class="flex flex-wrap items-center gap-2">
        <select
          class="rounded-sm border border-line bg-surface px-2 py-1 text-meta text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
          value={insights.kind}
          onchange={(event) => insights.setKind((event.currentTarget as HTMLSelectElement).value as 'overview' | 'workflow' | 'usage')}
        >
          <option value="overview">Overview</option>
          <option value="workflow">Workflow</option>
          <option value="usage">Usage</option>
        </select>

        <select
          class="rounded-sm border border-line bg-surface px-2 py-1 text-meta text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
          value={insights.provider}
          onchange={(event) => insights.setProvider((event.currentTarget as HTMLSelectElement).value as 'openai' | 'anthropic' | 'gemini')}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Gemini</option>
        </select>

        <input
          type="text"
          class="min-w-[14rem] rounded-sm border border-line bg-surface px-3 py-1 text-meta text-text transition-colors placeholder:text-text-faint hover:border-line-strong focus:border-accent focus:outline-none"
          placeholder="Model"
          value={insights.model}
          oninput={(event) => insights.setModel((event.currentTarget as HTMLInputElement).value)}
        />
      </div>

      <textarea
        class="min-h-24 rounded-sm border border-line bg-surface-2 px-3 py-2 text-body text-text transition-colors placeholder:text-text-faint focus:border-accent focus:outline-none"
        placeholder="Optional steering, e.g. focus on cost hotspots or workflow bottlenecks."
        bind:value={insights.prompt}
        oninput={(event) => insights.setPrompt((event.currentTarget as HTMLTextAreaElement).value)}
      ></textarea>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="text-meta text-text-faint">
          Provider: <span class="text-text-muted">{formatProvider(insights.provider)}</span>
          <span class="mx-2 text-line-strong">•</span>
          Model: <span class="text-text-muted">{insights.model}</span>
        </div>

        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" onclick={() => insights.clearFilters()}>Reset</Button>
          <Button variant="neutral" size="sm" onclick={() => insights.load()}>Refresh</Button>
          <Button
            variant="primary"
            size="sm"
            onclick={() => insights.generate()}
            disabled={insights.generating || !insights.selectedProviderConfigured}
          >
            {insights.generating ? 'Generating…' : 'Generate Insight'}
          </Button>
        </div>
      </div>
    </div>
  </div>

  {#if !insights.selectedProviderConfigured}
    <div class="flex items-start gap-2 text-meta text-text-muted">
      <span class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true"></span>
      <p>{formatProvider(insights.provider)} insight generation is not configured. Set the matching provider API key in the environment before generating new insights.</p>
    </div>
  {/if}

  {#if insights.error}
    <div class="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-meta text-danger">
      {insights.error}
    </div>
  {/if}

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
    <section class="rounded-lg border border-line bg-surface xl:col-span-4">
      <div class="border-b border-line px-4 py-3">
        <h3 class="text-h3">Saved Insights</h3>
        <div class="mt-0.5 text-meta text-text-muted">
          {insights.items.length} insight{insights.items.length === 1 ? '' : 's'} in this slice
        </div>
      </div>

      <div class="max-h-[70vh] overflow-y-auto">
        {#if insights.loading}
          <div class="px-4 py-12 text-center text-meta text-text-muted">Loading insights…</div>
        {:else if insights.items.length === 0}
          <div class="px-4 py-12 text-center text-meta text-text-muted">No saved insights for the current filters.</div>
        {:else}
          <div class="divide-y divide-line/60">
            {#each insights.items as item}
              <button
                class={`block w-full px-4 py-3 text-left transition-colors hover:bg-surface-2 ${insights.selectedId === item.id ? 'bg-surface-2' : ''}`}
                onclick={() => insights.select(item.id)}
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="truncate font-medium text-text">{item.title}</div>
                    <div class="mt-1 flex flex-wrap items-center gap-2 text-meta text-text-faint">
                      <Badge tone="neutral">{formatKind(item.kind)}</Badge>
                      <span class="tabular font-mono">{item.date_from}{item.date_from === item.date_to ? '' : ` → ${item.date_to}`}</span>
                    </div>
                  </div>
                  <div class="shrink-0 tabular font-mono text-meta text-text-faint">{formatDateTime(item.created_at)}</div>
                </div>
                <div class="mt-2 text-meta text-text-muted">
                  {item.project || 'All projects'} • {formatAgent(item.agent)}
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </section>

    <section class="rounded-lg border border-line bg-surface xl:col-span-8">
      {#if insights.selected}
        <div class="border-b border-line px-4 py-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-h2">{insights.selected.title}</h2>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-meta text-text-faint">
                <Badge tone="neutral">{formatKind(insights.selected.kind)}</Badge>
                <span class="tabular font-mono">{insights.selected.date_from}{insights.selected.date_from === insights.selected.date_to ? '' : ` → ${insights.selected.date_to}`}</span>
                <span>{insights.selected.project || 'All projects'}</span>
                <span>{formatAgent(insights.selected.agent)}</span>
                <span>{formatProvider(insights.selected.provider)}</span>
                <span class="font-mono">{insights.selected.model}</span>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <div class="tabular font-mono text-meta text-text-faint">{formatDateTime(insights.selected.created_at)}</div>
              <Button variant="danger" size="sm" onclick={() => insights.removeSelected()} disabled={insights.deleting}>
                {insights.deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-px overflow-hidden border-b border-line bg-line md:grid-cols-4">
          <div class="bg-surface px-4 py-3"><Stat label="Sessions" value={formatNumber(insights.selected.analytics_summary.total_sessions)} /></div>
          <div class="bg-surface px-4 py-3"><Stat label="Messages" value={formatNumber(insights.selected.analytics_summary.total_messages)} /></div>
          <div class="bg-surface px-4 py-3"><Stat label="Usage Events" value={formatNumber(insights.selected.usage_summary.total_usage_events)} /></div>
          <div class="bg-surface px-4 py-3"><Stat label="Cost" value={formatCost(insights.selected.usage_summary.total_cost_usd)} /></div>
        </div>

        <div class="grid grid-cols-1 gap-3 border-b border-line px-4 py-4 lg:grid-cols-2">
          <div class="rounded-sm border border-line bg-surface-2 px-3 py-3">
            <div class="flex items-center gap-2 text-meta font-medium text-text">
              <span class="inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true"></span> Analytics Coverage
            </div>
            <p class="mt-1 text-meta text-text-muted">
              {formatNumber(insights.selected.analytics_coverage.included_sessions)} of {formatNumber(insights.selected.analytics_coverage.matching_sessions)} matching sessions are included. {insights.selected.analytics_coverage.note}
            </p>
          </div>
          <div class="rounded-sm border border-line bg-surface-2 px-3 py-3">
            <div class="flex items-center gap-2 text-meta font-medium text-text">
              <span class="inline-block h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true"></span> Usage Coverage
            </div>
            <p class="mt-1 text-meta text-text-muted">
              {formatNumber(insights.selected.usage_coverage.usage_events)} of {formatNumber(insights.selected.usage_coverage.matching_events)} matching events carry usage metrics. {insights.selected.usage_coverage.note}
            </p>
          </div>
        </div>

        {#if insights.selected.prompt}
          <div class="border-b border-line px-4 py-4">
            <div class="text-meta font-medium text-text">Prompt Steering</div>
            <p class="mt-2 text-body text-text-muted">{insights.selected.prompt}</p>
          </div>
        {/if}

        <div class="px-4 py-4">
          <div class="text-meta font-medium text-text">Insight</div>
          <pre class="mt-3 whitespace-pre-wrap break-words rounded-sm border border-line bg-surface-2 p-4 text-body leading-6 text-text-muted">{insights.selected.content}</pre>
        </div>
      {:else}
        <div class="px-4 py-16 text-center text-meta text-text-muted">
          Select a saved insight or generate a new one to inspect it here.
        </div>
      {/if}
    </section>
  </div>
</main>
