<script lang="ts">
  interface SubTab {
    id: string;
    label: string;
  }

  interface Props {
    tabs: SubTab[];
    active: string;
    onchange: (id: string) => void;
    class?: string;
  }

  let { tabs, active, onchange, class: klass = '' }: Props = $props();
</script>

<div class="inline-flex items-center gap-1 rounded-sm border border-line bg-surface p-0.5 {klass}">
  {#each tabs as tab}
    <button
      type="button"
      class="rounded-sm px-3 py-1 text-meta transition-colors {active === tab.id
        ? 'bg-surface-2 text-text'
        : 'text-text-muted hover:text-text'}"
      aria-pressed={active === tab.id}
      onclick={() => onchange(tab.id)}
    >
      {tab.label}
    </button>
  {/each}
</div>
