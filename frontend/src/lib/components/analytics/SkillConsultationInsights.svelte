<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { analyticsFilters } from '../../stores/analytics-filters.svelte';
  import { buildAnalyticsRouteHash } from '../../route-state';
  import {
    agentColor,
    agentDisplayName,
    agentHexColor,
    formatNumber,
  } from '../../format';
  import {
    countSkillRows,
    selectSkillConsultationPreview,
  } from '../../skill-consultation-view';
  import { Button, Panel } from '../ui';

  const result = $derived(analytics.skillConsultations);
  const totalSkills = $derived(countSkillRows(result?.byHarness ?? []));
  const previewHarnesses = $derived(
    selectSkillConsultationPreview(result?.byHarness ?? [], 6),
  );
  const previewSkills = $derived(countSkillRows(previewHarnesses));

  function percent(value: number | null): string {
    return value === null ? '—' : `${Math.round(value * 100)}%`;
  }

  function harnessInvocations(
    harness: NonNullable<typeof result>['byHarness'][number],
  ): number {
    return harness.skills.reduce((total, skill) => total + skill.invocations, 0);
  }
</script>

<div role="region" aria-labelledby="skill-consultations-heading">
  <Panel padded={false}>
    {#snippet header()}
      <div class="min-w-0">
        <h3 id="skill-consultations-heading" class="text-h3">Skill consultations</h3>
        <p class="mt-0.5 max-w-[65ch] text-meta text-text-muted">
          A bounded index of observed reads. Open Skills for the complete evidence ledger.
        </p>
      </div>
    {/snippet}

    {#snippet actions()}
      {#if totalSkills > 0}
        <Button
          variant="neutral"
          size="sm"
          href={`#${buildAnalyticsRouteHash({
            ...analyticsFilters.snapshot,
            view: 'skills',
          })}`}
        >
          Explore all {formatNumber(totalSkills)} skills
        </Button>
      {/if}
    {/snippet}

    {#if analytics.loading.skillConsultations}
      <div class="px-4 py-10 text-center text-meta text-text-muted">
        Loading consultation evidence…
      </div>
    {:else if analytics.errors.skillConsultations}
      <div class="px-4 py-10 text-center text-meta text-danger">
        {analytics.errors.skillConsultations}
      </div>
    {:else if result && totalSkills > 0}
      <div class="grid border-b border-line sm:grid-cols-2">
        {#each result.byHarness as harness}
          <div class="flex items-center justify-between gap-4 border-b border-line px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
            <div class="flex min-w-0 items-center gap-2">
              <span
                class="h-1.5 w-1.5 shrink-0 rounded-full"
                style={`background-color:${agentHexColor(harness.harness)}`}
                aria-hidden="true"
              ></span>
              <span class="text-body font-semibold {agentColor(harness.harness)}">
                {agentDisplayName(harness.harness)}
              </span>
            </div>
            <div class="text-right font-mono text-meta tabular text-text-muted">
              <span class="text-text">{formatNumber(harness.skills.length)}</span> skills
              <span class="px-1 text-text-faint">·</span>
              <span class="text-text">{formatNumber(harnessInvocations(harness))}</span> reads
            </div>
          </div>
        {/each}
      </div>

      {#each previewHarnesses as harness}
        <section aria-labelledby={`skill-preview-harness-${harness.harness}`}>
          <div class="flex items-center justify-between gap-3 bg-surface-2/40 px-4 py-2">
            <h4
              id={`skill-preview-harness-${harness.harness}`}
              class="flex items-center gap-2 text-meta font-semibold {agentColor(harness.harness)}"
            >
              <span
                class="h-1.5 w-1.5 rounded-full"
                style={`background-color:${agentHexColor(harness.harness)}`}
                aria-hidden="true"
              ></span>
              {agentDisplayName(harness.harness)}
            </h4>
            <span class="text-meta text-text-faint">highest consultation volume</span>
          </div>

          <div>
            {#each harness.skills as skill}
              <div
                class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0 sm:grid-cols-[minmax(10rem,1fr)_repeat(3,minmax(5.25rem,auto))]"
                data-testid="skill-preview-row"
              >
                <div class="min-w-0">
                  <div class="truncate font-mono text-body font-medium text-text" translate="no">{skill.name}</div>
                  <div class="text-meta text-text-faint">
                    {formatNumber(skill.projectBreadth.distinctObservedProjects)} identified project{skill.projectBreadth.distinctObservedProjects === 1 ? '' : 's'}
                  </div>
                </div>
                <div class="text-right">
                  <div class="font-mono text-body tabular text-text">{formatNumber(skill.invocations)}</div>
                  <div class="text-meta text-text-faint">reads</div>
                </div>
                <div class="text-left sm:text-right">
                  <div class="font-mono text-body tabular text-text">{percent(skill.firstReadEngagementRate)}</div>
                  <div class="text-meta text-text-faint">first read</div>
                </div>
                <div class="text-right">
                  <div class="font-mono text-body tabular text-text">
                    {formatNumber(skill.classes.rehydration_after_compaction)}
                  </div>
                  <div class="text-meta text-text-faint">rehydrated</div>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/each}

      {#if totalSkills > previewSkills}
        <div class="border-t border-line px-4 py-2.5 text-meta text-text-muted">
          Showing {formatNumber(previewSkills)} of {formatNumber(totalSkills)} skill rows.
          Detection semantics remain separate by harness.
        </div>
      {/if}
    {:else}
      <div class="px-4 py-10 text-center text-meta text-text-muted">
        No skill consultation evidence for the selected range.
      </div>
    {/if}
  </Panel>
</div>
