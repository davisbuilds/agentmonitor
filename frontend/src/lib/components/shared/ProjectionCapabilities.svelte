<script lang="ts">
  import type { SessionCapabilities, SessionCapabilityLevel } from '../../api/client';
  import {
    capabilityLevelText,
    getCapabilityEntries,
    summarizeCapabilities,
    type CapabilitySummaryTone,
  } from '../../session-capabilities';

  interface Props {
    capabilities: SessionCapabilities | null;
    variant?: 'summary' | 'detail';
  }

  let { capabilities, variant = 'detail' }: Props = $props();

  const summary = $derived.by(() => summarizeCapabilities(capabilities));
  const entries = $derived.by(() => getCapabilityEntries(capabilities));

  function summaryToneClasses(tone: CapabilitySummaryTone): string {
    switch (tone) {
      case 'full':
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
      case 'summary':
        return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
      case 'mixed':
        return 'border-sky-500/30 bg-sky-500/10 text-sky-300';
      default:
        return 'border-gray-700 text-gray-400';
    }
  }

  function levelClasses(level: SessionCapabilityLevel): string {
    switch (level) {
      case 'full':
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
      case 'summary':
        return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
      default:
        return 'border-gray-700 text-gray-500';
    }
  }
</script>

{#if variant === 'summary'}
  <span
    class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${summaryToneClasses(summary.tone)}`}
    title={summary.description}
  >
    {summary.label}
  </span>
{:else if entries.length > 0}
  <div class="flex flex-wrap gap-2">
    {#each entries as entry (entry.key)}
      <span class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${levelClasses(entry.level)}`}>
        {entry.shortLabel} {capabilityLevelText(entry.level)}
      </span>
    {/each}
  </div>
{:else}
  <span class="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
    capabilities unknown
  </span>
{/if}
