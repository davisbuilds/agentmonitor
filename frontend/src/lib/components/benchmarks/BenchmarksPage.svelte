<script lang="ts">
  import { onMount } from 'svelte';
  import { benchmarksStore } from '../../stores/benchmarks.svelte';
  import { Panel, SectionHeader, DataTable, Badge, Bar, Button, EmptyState } from '../ui';
  import type { BenchmarkVerdict, BenchmarkCostBasis } from '../../api/client';

  const store = benchmarksStore;

  onMount(() => {
    void store.loadStudies();
    store.syncFromHash();
    const onHash = (): void => store.syncFromHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });

  const verdictTone: Record<BenchmarkVerdict, 'ok' | 'accent' | 'neutral' | 'warn'> = {
    'value-pick': 'ok',
    'on-frontier': 'accent',
    'trivial-only': 'neutral',
    dominated: 'neutral',
    unreliable: 'warn',
  };
  const verdictLabel: Record<BenchmarkVerdict, string> = {
    'value-pick': 'value pick',
    'on-frontier': 'on frontier',
    'trivial-only': 'trivial only',
    dominated: 'dominated',
    unreliable: 'unreliable',
  };
  const basisTone: Record<BenchmarkCostBasis, 'ok' | 'neutral' | 'warn'> = {
    captured: 'ok',
    derived: 'neutral',
    unpriced: 'warn',
  };

  function money(v: number | null): string {
    if (v == null) return '—';
    return v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
  }
  function score(v: number): string {
    return v.toFixed(3);
  }
  // Two runs of one suite on the same day share a slug but not a study_id; show a
  // date + short id line so reruns are distinguishable in the list.
  function shortId(id: string): string {
    return id.length > 10 ? `${id.slice(0, 8)}…` : id;
  }
  function studySubline(s: { study_id: string; date_from: string | null }): string {
    const day = s.date_from ? s.date_from.slice(0, 10) : null;
    return day ? `${shortId(s.study_id)} · ${day}` : shortId(s.study_id);
  }

  const studyColumns = [
    { key: 'study', label: 'Study' },
    { key: 'suite', label: 'Suite' },
    { key: 'arm_count', label: 'Arms', numeric: true },
    { key: 'cell_count', label: 'Cells', numeric: true },
    { key: 'total_cost_usd', label: 'Total cost', numeric: true },
    { key: 'cost_basis', label: 'Cost basis' },
  ];

  const armColumns = [
    { key: 'label', label: 'Arm' },
    { key: 'verdict', label: 'Verdict' },
    { key: 'mean_score', label: 'Score', numeric: true },
    { key: 'cost_per_trial', label: '$/trial', numeric: true },
    { key: 'native', label: 'Routing' },
    { key: 'flags', label: 'Notes' },
  ];

  const maxScore = $derived(Math.max(0.01, ...(store.detail?.arms.map(a => a.mean_score) ?? [1])));

  const caveats = $derived.by(() => {
    const d = store.detail;
    if (!d) return [] as string[];
    const out: string[] = [];
    const unpriced = d.arms.filter(a => a.cost_basis === 'unpriced').map(a => a.label);
    const derived = d.arms.filter(a => a.cost_basis === 'derived').length;
    if (unpriced.length) out.push(`${unpriced.length} arm(s) unpriced — no cost-axis position: ${unpriced.join(', ')}.`);
    if (derived) out.push(`${derived} arm(s) show derived list-price cost, not captured — treat as a floor.`);
    for (const a of d.arms.filter(a => a.noop_trials > 0)) {
      out.push(`${a.label}: ${a.noop_trials} no-op trial(s) — success with no workspace change.`);
    }
    for (const a of d.arms.filter(a => a.excluded_trials > 0)) {
      out.push(`${a.label}: only ${a.n} of ${d.expected_trials} trials — small sample.`);
    }
    for (const a of d.arms.filter(a => !a.ranking_eligible)) {
      out.push(`${a.label}: usage excluded from ranking${a.ranking_exclusion_reason ? ` — ${a.ranking_exclusion_reason}` : ''}.`);
    }
    // Token usage not backed by the vendor's own numbers is a weaker basis.
    for (const a of d.arms.filter(a => a.usage_evidence_grade && a.usage_evidence_grade !== 'vendor_reported')) {
      out.push(`${a.label}: token usage graded "${a.usage_evidence_grade}", not vendor-reported.`);
    }
    return out;
  });
</script>

<main class="flex-1 overflow-hidden flex flex-col p-4 sm:p-6">
  {#if store.selectedStudyId}
    <!-- Study detail -->
    <div class="mb-3">
      <Button variant="ghost" onclick={() => void store.select(null)}>← Studies</Button>
    </div>

    {#if store.detailLoading}
      <p class="text-meta text-text-muted">Loading study…</p>
    {:else if store.detailError}
      <p class="text-meta text-danger">{store.detailError}</p>
    {:else if store.detail}
      {@const d = store.detail}
      <SectionHeader title={d.study} count={`${d.arms.length} arms`}>
        {#snippet actions()}
          <span class="text-meta text-text-faint">
            {d.suite ? `suite ${d.suite} · ` : ''}{d.tasks.length} task{d.tasks.length === 1 ? '' : 's'} · {d.expected_trials} trials/arm
          </span>
        {/snippet}
      </SectionHeader>

      <div class="flex-1 overflow-y-auto">
        <Panel title="The ladder" subtitle="Arms ranked by score; frontier verdicts and honesty flags computed from the run" padded={false}>
          <DataTable columns={armColumns} rows={d.arms} rowKey={(a) => a.label} empty="No arms">
            {#snippet cell(arm, column)}
              {#if column.key === 'label'}
                <span class="text-text">{arm.label}</span>
              {:else if column.key === 'verdict'}
                <Badge tone={verdictTone[arm.verdict]} title={arm.dominated_by ? `beaten by ${arm.dominated_by}` : ''}>
                  {verdictLabel[arm.verdict]}
                </Badge>
              {:else if column.key === 'mean_score'}
                <div class="flex items-center justify-end gap-2">
                  <span class="tabular font-mono">{score(arm.mean_score)}</span>
                  <div class="w-16"><Bar value={arm.mean_score} max={maxScore} tone="accent" /></div>
                </div>
              {:else if column.key === 'cost_per_trial'}
                {money(arm.cost_per_trial)}
              {:else if column.key === 'native'}
                <span class="text-text-muted" title={arm.native ? 'first-party / subscription' : 'OpenRouter-routed'}>
                  {arm.native ? '◯ native' : '● routed'}
                </span>
              {:else if column.key === 'flags'}
                <span class="flex flex-wrap gap-1">
                  {#if arm.cost_basis !== 'captured'}<Badge tone={basisTone[arm.cost_basis]}>{arm.cost_basis}</Badge>{/if}
                  {#if arm.excluded_trials > 0}<Badge tone="warn" title="fewer trials than the study max">n={arm.n}</Badge>{/if}
                  {#if arm.noop_trials > 0}<Badge tone="warn" title="success with no workspace change">{arm.noop_trials} no-op</Badge>{/if}
                  {#if !arm.ranking_eligible}<Badge tone="warn" title={arm.ranking_exclusion_reason ?? 'usage excluded from ranking'}>ineligible</Badge>{/if}
                </span>
              {/if}
            {/snippet}
          </DataTable>
        </Panel>

        {#if caveats.length > 0}
          <Panel title="Read the fine print" class="mt-4">
            <ul class="flex flex-col gap-2">
              {#each caveats as c}
                <li class="text-meta text-text-muted">{c}</li>
              {/each}
            </ul>
          </Panel>
        {/if}
      </div>
    {/if}
  {:else}
    <!-- Studies list -->
    <SectionHeader title="Benchmarks" count={store.studies.length ? `${store.studies.length} studies` : undefined} />
    {#if store.loading}
      <p class="text-meta text-text-muted">Loading studies…</p>
    {:else if store.error}
      <p class="text-meta text-danger">{store.error}</p>
    {:else if store.studies.length === 0}
      <EmptyState
        title="No benchmark studies yet"
        description="Import an openbench run with `amon import benchmark <results.jsonl>`. Benchmark data is segregated from your usage and analytics; it only appears here."
      />
    {:else}
      <div class="flex-1 overflow-y-auto">
        <Panel padded={false}>
          <DataTable
            columns={studyColumns}
            rows={store.studies}
            rowKey={(s) => s.study_id}
            onrowclick={(s) => void store.select(s.study_id)}
          >
            {#snippet cell(s, column)}
              {#if column.key === 'study'}
                <div class="flex flex-col">
                  <span class="text-text">{s.study}</span>
                  <span class="text-meta text-text-faint font-mono">{studySubline(s)}</span>
                </div>
              {:else if column.key === 'suite'}
                <span class="text-text-muted">{s.suite ?? '—'}</span>
              {:else if column.key === 'arm_count'}
                {s.arm_count}
              {:else if column.key === 'cell_count'}
                {s.cell_count}
              {:else if column.key === 'total_cost_usd'}
                {money(s.total_cost_usd)}
              {:else if column.key === 'cost_basis'}
                <Badge tone={basisTone[s.cost_basis]}>{s.cost_basis}</Badge>
              {/if}
            {/snippet}
          </DataTable>
        </Panel>
      </div>
    {/if}
  {/if}
</main>
