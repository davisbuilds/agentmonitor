<script lang="ts">
  import { analytics } from '../../stores/analytics.svelte';
  import { agentColor, agentDisplayName, formatNumber } from '../../format';
  import type {
    SkillConsultationRow,
    SkillConsultationVersionRow,
  } from '../../api/client';
  import { Badge, Panel } from '../ui';

  function percent(value: number | null): string {
    return value === null ? '—' : `${Math.round(value * 100)}%`;
  }

  function reasonLabel(reason: string): string {
    return reason.replaceAll('_', ' ');
  }

  function versionLabel(version: SkillConsultationVersionRow): string {
    return version.version ?? 'Unknown version';
  }

  function attributionTone(
    attribution: SkillConsultationVersionRow['attribution'],
  ): 'ok' | 'warn' | 'neutral' {
    if (attribution === 'exact') return 'ok';
    if (attribution === 'approximate') return 'warn';
    return 'neutral';
  }

  function exposureLabel(skill: SkillConsultationRow): string {
    if (skill.exposure.jointlyEligiblePresentedSessions === 0) return '—';
    return `${formatNumber(skill.exposure.presentedWithoutFirstRead)} / ${formatNumber(skill.exposure.jointlyEligiblePresentedSessions)}`;
  }

  const result = $derived(analytics.skillConsultations);
  const hasSkills = $derived(
    result?.byHarness.some((harness) => harness.skills.length > 0) ?? false,
  );
</script>

<div role="region" aria-labelledby="skill-consultations-heading">
  <Panel padded={false}>
    {#snippet header()}
      <div class="min-w-0">
        <h3 id="skill-consultations-heading" class="text-h3">Skill consultations</h3>
        <p class="mt-0.5 max-w-[65ch] text-meta text-text-muted">
          First reads measure observed engagement. Rehydrations follow observed compaction; none of these signals measure outcome value.
        </p>
      </div>
    {/snippet}

    {#if analytics.loading.skillConsultations}
      <div class="px-4 py-12 text-center text-meta text-text-muted">
        Loading consultation evidence…
      </div>
    {:else if analytics.errors.skillConsultations}
      <div class="px-4 py-12 text-center text-meta text-danger">
        {analytics.errors.skillConsultations}
      </div>
    {:else if result}
      {#if result.comparability.status === 'not_directly_comparable'}
        <div class="flex items-start gap-2 border-b border-line px-4 py-3 text-meta text-text-muted">
          <span class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true"></span>
          <p>
            Claude and Codex are shown separately because their detection semantics differ. Rates are not pooled across harnesses.
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

      {#if hasSkills}
        {#each result.byHarness as harness}
          <section
            class="border-b border-line last:border-b-0"
            aria-labelledby={`skill-harness-${harness.harness}`}
          >
            <div class="flex flex-wrap items-baseline justify-between gap-2 bg-surface-2/50 px-4 py-2.5">
              <div class="flex items-center gap-2">
                <span class="h-1.5 w-1.5 rounded-full {harness.harness === 'claude' ? 'bg-claude' : 'bg-codex'}" aria-hidden="true"></span>
                <h4
                  id={`skill-harness-${harness.harness}`}
                  class="text-body font-semibold {agentColor(harness.harness)}"
                >
                  {agentDisplayName(harness.harness)}
                </h4>
              </div>
              <span class="font-mono text-meta text-text-faint">
                {harness.detectionSemantics === 'explicit_skill_tool'
                  ? 'explicit Skill tool'
                  : 'concrete SKILL.md path'}
              </span>
            </div>

            {#if harness.skills.length > 0}
              <div>
                {#each harness.skills as skill}
                  <details class="group border-t border-line first:border-t-0">
                    <summary
                      class="relative cursor-pointer list-none px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 [&::-webkit-details-marker]:hidden"
                    >
                      <div class="grid grid-cols-2 items-center gap-3 lg:grid-cols-[minmax(9rem,1.35fr)_repeat(5,minmax(5.25rem,0.7fr))]">
                        <div class="col-span-2 min-w-0 pr-6 lg:col-span-1 lg:pr-0">
                          <div class="truncate font-mono text-body font-medium text-text">{skill.name}</div>
                          <div class="mt-0.5 text-meta text-text-faint">
                            {formatNumber(skill.invocations)} consultation occurrence{skill.invocations === 1 ? '' : 's'}
                          </div>
                        </div>

                        <div>
                          <div class="tabular font-mono text-body font-semibold text-text">
                            {#if skill.eligibleSessionsInWindow > 0}
                              {formatNumber(skill.sessionsWithFirstRead)} / {formatNumber(skill.eligibleSessionsInWindow)}
                            {:else}
                              —
                            {/if}
                          </div>
                          <div class="text-meta text-text-faint">
                            {skill.eligibleSessionsInWindow > 0
                              ? `${percent(skill.firstReadEngagementRate)} first read`
                              : 'no eligible sessions'}
                          </div>
                        </div>

                        <div>
                          <div class="tabular font-mono text-body text-text">{formatNumber(skill.classes.rehydration_after_compaction)}</div>
                          <div class="text-meta text-text-faint">rehydrations</div>
                        </div>

                        <div>
                          <div class="tabular font-mono text-body text-text">
                            {formatNumber(skill.classes.repeat_no_compaction)} · {formatNumber(skill.classes.unclassifiable)}
                          </div>
                          <div class="text-meta text-text-faint">repeat · unknown</div>
                        </div>

                        <div>
                          <div class="tabular font-mono text-body text-text">{formatNumber(skill.projectBreadth.distinctObservedProjects)}</div>
                          <div class="text-meta text-text-faint">projects observed</div>
                        </div>

                        <div class="col-span-2 lg:col-span-1">
                          <div class="tabular font-mono text-body text-text">{exposureLabel(skill)}</div>
                          <div class="text-meta text-text-faint">
                            {skill.exposure.jointlyEligiblePresentedSessions > 0
                              ? 'presented, no first read'
                              : 'presentation unavailable'}
                          </div>
                        </div>

                        <span
                          class="absolute right-4 top-4 text-text-faint transition-transform duration-150 group-open:rotate-90"
                          aria-hidden="true"
                        >›</span>
                      </div>
                    </summary>

                    <div class="grid gap-4 border-t border-line bg-canvas/40 px-4 py-4 lg:grid-cols-3">
                      <section>
                        <h5 class="mb-2 text-meta font-semibold uppercase tracking-wide text-text-faint">Version attribution</h5>
                        {#if skill.versions.length > 0}
                          <div class="space-y-2">
                            {#each skill.versions as version}
                              <div class="flex items-center justify-between gap-3 text-meta">
                                <div class="flex min-w-0 items-center gap-2">
                                  <span class="truncate font-mono text-text">{versionLabel(version)}</span>
                                  <Badge tone={attributionTone(version.attribution)}>{version.attribution}</Badge>
                                </div>
                                <span class="tabular font-mono text-text-muted">{formatNumber(version.invocations)}</span>
                              </div>
                            {/each}
                          </div>
                        {:else}
                          <p class="text-meta text-text-muted">No version attribution was retained.</p>
                        {/if}
                      </section>

                      <section>
                        <h5 class="mb-2 text-meta font-semibold uppercase tracking-wide text-text-faint">Project breadth</h5>
                        {#if skill.projectBreadth.sessions.length > 0}
                          <div class="space-y-2">
                            {#each skill.projectBreadth.sessions as project}
                              <div class="flex items-center justify-between gap-3 text-meta">
                                <span class="truncate text-text">{project.label}</span>
                                <span class="tabular font-mono text-text-muted">{formatNumber(project.sessions)}</span>
                              </div>
                            {/each}
                          </div>
                        {:else}
                          <p class="text-meta text-text-muted">No first-read project evidence was retained.</p>
                        {/if}
                      </section>

                      <section>
                        <h5 class="mb-2 text-meta font-semibold uppercase tracking-wide text-text-faint">Coverage and exposure</h5>
                        <dl class="space-y-2 text-meta">
                          <div class="flex justify-between gap-3">
                            <dt class="text-text-muted">Sessions in window</dt>
                            <dd class="tabular font-mono text-text">{formatNumber(skill.sessionsInWindow)}</dd>
                          </div>
                          <div class="flex justify-between gap-3">
                            <dt class="text-text-muted">Eligible sessions</dt>
                            <dd class="tabular font-mono text-text">{formatNumber(skill.eligibleSessionsInWindow)}</dd>
                          </div>
                          <div class="flex justify-between gap-3">
                            <dt class="text-text-muted">Presented with first read</dt>
                            <dd class="tabular font-mono text-text">{formatNumber(skill.exposure.presentedWithFirstRead)}</dd>
                          </div>
                        </dl>
                        {#if skill.ineligibleSessionsByReason.length > 0}
                          <div class="mt-3 border-t border-line pt-2">
                            {#each skill.ineligibleSessionsByReason as reason}
                              <div class="flex justify-between gap-3 py-1 text-meta">
                                <span class="text-text-muted">{reasonLabel(reason.reason)}</span>
                                <span class="tabular font-mono text-text">{formatNumber(reason.sessions)}</span>
                              </div>
                            {/each}
                          </div>
                        {:else}
                          <p class="mt-3 text-meta text-text-muted">No classification exclusions.</p>
                        {/if}
                      </section>
                    </div>
                  </details>
                {/each}
              </div>
            {:else}
              <div class="px-4 py-8 text-center text-meta text-text-muted">
                No {agentDisplayName(harness.harness)} consultation evidence for this range.
              </div>
            {/if}
          </section>
        {/each}
      {:else}
        <div class="px-4 py-12 text-center text-meta text-text-muted">
          No skill consultation evidence for the selected range.
        </div>
      {/if}
    {:else}
      <div class="px-4 py-12 text-center text-meta text-text-muted">
        No skill consultation evidence has been loaded.
      </div>
    {/if}
  </Panel>
</div>
