<script lang="ts">
  import { formatNumber } from '../../format';
  import type {
    SkillConsultationRow,
    SkillConsultationVersionRow,
  } from '../../api/client';
  import { Badge } from '../ui';

  interface Props {
    skill: SkillConsultationRow;
  }

  let { skill }: Props = $props();

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

  function exposureLabel(): string {
    if (skill.exposure.jointlyEligiblePresentedSessions === 0) return '—';
    return `${formatNumber(skill.exposure.presentedWithoutFirstRead)} / ${formatNumber(skill.exposure.jointlyEligiblePresentedSessions)}`;
  }
</script>

<details class="group border-t border-line first:border-t-0">
  <summary
    class="relative cursor-pointer list-none px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 [&::-webkit-details-marker]:hidden"
  >
    <div class="grid grid-cols-2 items-center gap-3 lg:grid-cols-[minmax(9rem,1.35fr)_repeat(5,minmax(5.25rem,0.7fr))]">
      <div class="col-span-2 min-w-0 pr-6 lg:col-span-1 lg:pr-0">
        <div class="truncate font-mono text-body font-medium text-text" translate="no">{skill.name}</div>
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
        <div class="tabular font-mono text-body text-text">
          {formatNumber(skill.classes.rehydration_after_compaction)}
        </div>
        <div class="text-meta text-text-faint">rehydrations</div>
      </div>

      <div>
        <div class="tabular font-mono text-body text-text">
          {formatNumber(skill.classes.repeat_no_compaction)} · {formatNumber(skill.classes.unclassifiable)}
        </div>
        <div class="text-meta text-text-faint">repeat · unknown</div>
      </div>

      <div>
        <div class="tabular font-mono text-body text-text">
          {formatNumber(skill.projectBreadth.distinctObservedProjects)}
        </div>
        <div class="text-meta text-text-faint">identified projects</div>
      </div>

      <div class="col-span-2 lg:col-span-1">
        <div class="tabular font-mono text-body text-text">{exposureLabel()}</div>
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
      <h3 class="mb-2 text-meta font-semibold uppercase tracking-wide text-text-faint">Version attribution</h3>
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
      <h3 class="mb-2 text-meta font-semibold uppercase tracking-wide text-text-faint">Project breadth</h3>
      {#if skill.projectBreadth.sessions.length > 0}
        <div class="space-y-2">
          {#each skill.projectBreadth.sessions as project}
            <div class="flex items-center justify-between gap-3 text-meta">
              <span class="truncate text-text">{project.label}</span>
              <span class="tabular font-mono text-text-muted">{formatNumber(project.sessions)}</span>
            </div>
          {/each}
        </div>
        {#if skill.projectBreadth.sessions.some(project => project.id === 'unknown')}
          <p class="mt-2 text-meta text-text-faint">
            Identified project count excludes Unknown.
          </p>
        {/if}
      {:else}
        <p class="text-meta text-text-muted">No first-read project evidence was retained.</p>
      {/if}
    </section>

    <section>
      <h3 class="mb-2 text-meta font-semibold uppercase tracking-wide text-text-faint">Coverage and exposure</h3>
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
