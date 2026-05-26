<script lang="ts">
  import type { SessionCapabilities, SessionCapabilityLevel } from '../../api/client';
  import {
    capabilityLevelText,
    getCapabilityEntries,
    summarizeCapabilities,
    type CapabilitySummaryTone,
  } from '../../session-capabilities';
  import { Badge } from '../ui';

  interface Props {
    capabilities: SessionCapabilities | null;
    variant?: 'summary' | 'detail';
  }

  let { capabilities, variant = 'detail' }: Props = $props();

  const summary = $derived.by(() => summarizeCapabilities(capabilities));
  const entries = $derived.by(() => getCapabilityEntries(capabilities));

  type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn';

  // Capability levels map onto signal tokens: full = ok, summary = warn, mixed = accent.
  function summaryTone(tone: CapabilitySummaryTone): BadgeTone {
    switch (tone) {
      case 'full':
        return 'ok';
      case 'summary':
        return 'warn';
      case 'mixed':
        return 'accent';
      default:
        return 'neutral';
    }
  }

  function levelTone(level: SessionCapabilityLevel): BadgeTone {
    switch (level) {
      case 'full':
        return 'ok';
      case 'summary':
        return 'warn';
      default:
        return 'neutral';
    }
  }
</script>

{#if variant === 'summary'}
  <Badge tone={summaryTone(summary.tone)} title={summary.description} class="uppercase tracking-wide">
    {summary.label}
  </Badge>
{:else if entries.length > 0}
  <div class="flex flex-wrap gap-2">
    {#each entries as entry (entry.key)}
      <Badge tone={levelTone(entry.level)} class="uppercase tracking-wide">
        {entry.shortLabel}
        {capabilityLevelText(entry.level)}
      </Badge>
    {/each}
  </div>
{:else}
  <Badge tone="neutral" class="uppercase tracking-wide">capabilities unknown</Badge>
{/if}
