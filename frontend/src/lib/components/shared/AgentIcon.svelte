<script lang="ts">
  import antigravity from '../../assets/agent-icons/antigravity.svg?raw';
  import claudeCode from '../../assets/agent-icons/claude-code.svg?raw';
  import codex from '../../assets/agent-icons/codex.svg?raw';
  import { agentHexColor } from '../../format';

  const icons = new Map([
    ['antigravity', antigravity],
    ['claude', claudeCode],
    ['claude_code', claudeCode],
    ['codex', codex],
  ]);

  let { agent, fallbackDot = false }: { agent: string; fallbackDot?: boolean } = $props();
  const icon = $derived(icons.get(agent));
</script>

{#if icon}
  <span class="agent-icon inline-flex size-4 shrink-0 text-text" aria-hidden="true">
    {@html icon}
  </span>
{:else if fallbackDot}
  <span class="inline-block size-2 shrink-0 rounded-full" style:background-color={agentHexColor(agent)} aria-hidden="true"></span>
{/if}

<style>
  .agent-icon :global(svg) {
    width: 100%;
    height: 100%;
  }
</style>
