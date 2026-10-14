<script lang="ts">
  import type { SessionCapabilities, SessionCapabilityLevel } from '../../api/client';
  import {
    capabilityLevelLabel,
    describeCoverage,
    getCapabilityEntries,
    sessionSourceLabel,
    type CoverageTone,
  } from '../../session-capabilities';
  import { Popover } from '../ui';

  // How much of a session amon can show, as a tinted dot and a label
  // (DESIGN.md: status indicators are a dot + label, not a pill on every row).
  // `row` says nothing for a fully captured session; `detail` opens the breakdown.
  interface Props {
    capabilities: SessionCapabilities | null;
    integrationMode?: string | null;
    fidelity?: string | null;
    variant?: 'row' | 'detail';
  }

  let { capabilities, integrationMode = null, fidelity = null, variant = 'detail' }: Props = $props();

  const coverage = $derived(describeCoverage(capabilities));
  const entries = $derived(getCapabilityEntries(capabilities));

  const DOTS: Record<CoverageTone, string> = {
    ok: 'bg-ok',
    warn: 'bg-warn',
    accent: 'bg-accent',
    neutral: 'bg-line-strong',
  };

  function levelDot(level: SessionCapabilityLevel): string {
    return level === 'full' ? 'bg-ok' : level === 'summary' ? 'bg-warn' : 'bg-line-strong';
  }
</script>

{#if variant === 'row'}
  {#if !coverage.full}
    <span class="inline-flex items-center gap-1.5 text-meta text-text-faint">
      <span class="h-1.5 w-1.5 shrink-0 rounded-full {DOTS[coverage.tone]}" aria-hidden="true"></span>
      {coverage.label}
    </span>
  {/if}
{:else}
  <Popover align="right" width="w-72" label="Session detail">
    {#snippet trigger({ toggle, open })}
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-meta text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
        aria-haspopup="dialog"
        aria-expanded={open}
        onclick={toggle}
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full {DOTS[coverage.tone]}" aria-hidden="true"></span>
        {coverage.label}
      </button>
    {/snippet}
    <div class="space-y-3 text-meta">
      {#if entries.length > 0}
        <ul class="space-y-1.5">
          {#each entries as entry (entry.key)}
            <li class="flex items-center justify-between gap-3">
              <span class="text-text-muted">{entry.label}</span>
              <span class="inline-flex items-center gap-1.5 text-text">
                <span class="h-1.5 w-1.5 rounded-full {levelDot(entry.level)}" aria-hidden="true"></span>
                {capabilityLevelLabel(entry.level)}
              </span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-text-muted">This session did not report what it can show.</p>
      {/if}
      <div class="space-y-1 border-t border-line pt-2 text-text-faint">
        <div>Source: <span class="text-text-muted">{sessionSourceLabel(integrationMode)}</span></div>
        {#if fidelity}
          <div>Recorded at <span class="text-text-muted">{fidelity}</span> detail</div>
        {/if}
      </div>
    </div>
  </Popover>
{/if}
