<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { analyticsFilters } from '../../stores/analytics-filters.svelte';
  import {
    agentColor,
    agentDisplayName,
    agentHexColor,
    formatNumber,
  } from '../../format';
  import {
    countSkillRows,
    filterSkillConsultations,
    type SkillConsultationHarness,
    type SkillConsultationSignal,
    type SkillConsultationSort,
  } from '../../skill-consultation-view';
  import { Button, Panel, Select, SubTabs, Toolbar } from '../ui';
  import SkillConsultationEvidenceRow from './SkillConsultationEvidenceRow.svelte';

  const PAGE_SIZE = 30;

  const signalOptions = [
    { value: 'all', label: 'All signals' },
    { value: 'first_read', label: 'First read observed' },
    { value: 'rehydrated', label: 'Rehydrated' },
    { value: 'presented_unread', label: 'Presented, not read' },
    { value: 'unclassified', label: 'Unclassified' },
  ];
  const sortOptions = [
    { value: 'volume', label: 'Consultation volume' },
    { value: 'first_read_rate', label: 'First-read engagement' },
    { value: 'rehydrations', label: 'Rehydrations' },
    { value: 'name', label: 'Skill name' },
  ];

  let visibleLimit = $state(PAGE_SIZE);
  const filters = analyticsFilters;

  const result = $derived(analytics.skillConsultations);
  const harnessTabs = $derived([
    { id: '', label: 'All' },
    ...(result?.byHarness.map(harness => ({
      id: harness.harness,
      label: agentDisplayName(harness.harness),
    })) ?? []),
  ]);
  const filteredHarnesses = $derived(filterSkillConsultations(
    result?.byHarness ?? [],
    {
      harness: filters.skillHarness,
      query: filters.skillQuery,
      signal: filters.skillSignal,
      sort: filters.skillSort,
    },
  ));
  const visibleHarnesses = $derived(limitHarnesses(filteredHarnesses, visibleLimit));
  const totalSkills = $derived(countSkillRows(result?.byHarness ?? []));
  const filteredSkills = $derived(countSkillRows(filteredHarnesses));
  const visibleSkills = $derived(countSkillRows(visibleHarnesses));
  const comparedHarnesses = $derived(
    harnessList(filteredHarnesses.map(harness => harness.harness)),
  );
  const hasExplorerFilters = $derived(
    Boolean(
      filters.skillHarness
      || filters.skillQuery.trim()
      || filters.skillSignal !== 'all'
      || filters.skillSort !== 'volume'
    ),
  );

  $effect(() => {
    const available = result?.byHarness.map(harness => harness.harness) ?? [];
    if (filters.skillHarness && !available.includes(filters.skillHarness)) {
      filters.setSkillHarness('');
    }
  });

  function harnessList(harnesses: string[]): string {
    const names = harnesses.map(agentDisplayName);
    if (names.length < 2) return names[0] ?? 'Selected harnesses';
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
  }

  function limitHarnesses(
    harnesses: SkillConsultationHarness[],
    limit: number,
  ): SkillConsultationHarness[] {
    const selected = new Map<string, typeof harnesses[number]['skills']>(
      harnesses.map(harness => [harness.harness, []]),
    );
    let count = 0;
    let rank = 0;
    while (count < limit) {
      let addedAtRank = false;
      for (const harness of harnesses) {
        if (count >= limit) break;
        const row = harness.skills[rank];
        if (!row) continue;
        selected.get(harness.harness)?.push(row);
        count += 1;
        addedAtRank = true;
      }
      if (!addedAtRank) break;
      rank += 1;
    }
    return harnesses
      .map(harness => ({
        ...harness,
        skills: selected.get(harness.harness) ?? [],
      }))
      .filter(harness => harness.skills.length > 0);
  }

  function setHarness(value: string): void {
    filters.setSkillHarness(value);
    visibleLimit = PAGE_SIZE;
  }

  function setQuery(value: string): void {
    filters.setSkillQuery(value);
    visibleLimit = PAGE_SIZE;
  }

  function setSignal(value: string): void {
    filters.setSkillSignal(value as SkillConsultationSignal);
    visibleLimit = PAGE_SIZE;
  }

  function setSort(value: string): void {
    filters.setSkillSort(value as SkillConsultationSort);
    visibleLimit = PAGE_SIZE;
  }

  function resetFilters(): void {
    filters.clearSkillExplorerFilters();
    visibleLimit = PAGE_SIZE;
  }
</script>

<div role="region" aria-labelledby="skill-consultation-explorer-heading">
  <Panel padded={false}>
    {#snippet header()}
      <div class="min-w-0">
        <h1 id="skill-consultation-explorer-heading" class="text-h2 text-balance">Skill consultation explorer</h1>
        <p class="mt-0.5 max-w-[65ch] text-meta text-text-muted">
          Inspect observed first reads, rehydrations, catalog exposure, and attribution without treating them as outcome value.
        </p>
      </div>
    {/snippet}

    {#snippet actions()}
      {#if result && totalSkills > 0}
        <span class="whitespace-nowrap font-mono text-meta tabular text-text-muted" aria-live="polite">
          {formatNumber(filteredSkills)} / {formatNumber(totalSkills)} skills
        </span>
      {/if}
    {/snippet}

    {#if analytics.loading.skillConsultations}
      <div class="px-4 py-12 text-center text-meta text-text-muted">
        Loading consultation evidence…
      </div>
    {:else if analytics.errors.skillConsultations}
      <div class="px-4 py-12 text-center text-meta text-danger">
        {analytics.errors.skillConsultations}
      </div>
    {:else if result && totalSkills > 0}
      <div class="border-b border-line px-4 py-3">
        <Toolbar>
          {#if result.byHarness.length > 1}
            <div aria-label="Skill harness">
              <SubTabs
                tabs={harnessTabs}
                active={filters.skillHarness}
                onchange={setHarness}
              />
            </div>
          {/if}
          <input
            type="search"
            name="skill-query"
            autocomplete="off"
            class="min-w-48 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-meta text-text placeholder:text-text-faint transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
            aria-label="Search skills"
            placeholder="Search skills…"
            value={filters.skillQuery}
            oninput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
          />
          <Select
            value={filters.skillSignal}
            options={signalOptions}
            aria-label="Filter consultation signal"
            onchange={setSignal}
          />
          <Select
            value={filters.skillSort}
            options={sortOptions}
            aria-label="Sort skill consultations"
            onchange={setSort}
          />

          {#snippet actions()}
            {#if hasExplorerFilters && filteredSkills > 0}
              <Button
                variant="ghost"
                size="sm"
                aria-label="Reset explorer filters"
                onclick={resetFilters}
              >
                Reset
              </Button>
            {/if}
          {/snippet}
        </Toolbar>
      </div>

      {#if result.comparability.status === 'not_directly_comparable' && filteredHarnesses.length > 1}
        <div
          class="flex items-start gap-2 border-b border-line px-4 py-3 text-meta text-text-muted"
          data-testid="skill-comparability"
        >
          <span class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true"></span>
          <p>
            Consultation evidence for {comparedHarnesses} is shown in separate harness lanes because detection semantics differ. Rates are not pooled across harnesses.
          </p>
        </div>
      {/if}

      {#if result.windowSemantics.windowMembershipUnobservable > 0}
        <div class="flex items-start gap-2 border-b border-line px-4 py-3 text-meta text-text-muted">
          <span class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true"></span>
          <p>
            {formatNumber(result.windowSemantics.windowMembershipUnobservable)} session{result.windowSemantics.windowMembershipUnobservable === 1 ? '' : 's'} could not be placed in this window.
          </p>
        </div>
      {/if}

      {#if filteredSkills > 0}
        {#each visibleHarnesses as harness}
          <section
            class="border-b border-line last:border-b-0"
            aria-labelledby={`skill-harness-${harness.harness}`}
          >
            <div class="flex flex-wrap items-baseline justify-between gap-2 bg-surface-2/50 px-4 py-2.5">
              <div class="flex items-center gap-2">
                <span
                  class="h-1.5 w-1.5 rounded-full"
                  style={`background-color:${agentHexColor(harness.harness)}`}
                  aria-hidden="true"
                ></span>
                <h2
                  id={`skill-harness-${harness.harness}`}
                  class="text-body font-semibold {agentColor(harness.harness)}"
                >
                  {agentDisplayName(harness.harness)}
                </h2>
              </div>
              <span class="font-mono text-meta text-text-faint">
                {harness.detectionSemantics === 'explicit_skill_tool'
                  ? 'explicit Skill tool'
                  : 'concrete SKILL.md path'}
              </span>
            </div>

            <div>
              {#each harness.skills as skill}
                <SkillConsultationEvidenceRow {skill} />
              {/each}
            </div>
          </section>
        {/each}

        {#if visibleSkills < filteredSkills}
          <div class="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <span class="text-meta text-text-muted">
              Showing {formatNumber(visibleSkills)} of {formatNumber(filteredSkills)} matching skills
            </span>
            <Button
              variant="neutral"
              size="sm"
              onclick={() => { visibleLimit += PAGE_SIZE; }}
            >
              Show {formatNumber(Math.min(PAGE_SIZE, filteredSkills - visibleSkills))} more
            </Button>
          </div>
        {/if}
      {:else}
        <div class="px-4 py-12 text-center">
          <p class="text-body text-text">No skills match the explorer filters.</p>
          <p class="mt-1 text-meta text-text-muted">Try a broader name or evidence signal.</p>
          <Button
            class="mt-3"
            variant="neutral"
            size="sm"
            aria-label="Reset explorer filters"
            onclick={resetFilters}
          >
            Reset filters
          </Button>
        </div>
      {/if}
    {:else if result}
      <div class="px-4 py-12 text-center text-meta text-text-muted">
        No skill consultation evidence for the selected range.
      </div>
    {:else}
      <div class="px-4 py-12 text-center text-meta text-text-muted">
        No skill consultation evidence has been loaded.
      </div>
    {/if}
  </Panel>
</div>
