<script lang="ts">
  import { getFilterOptions, getFilters, setFilters } from '../../stores/monitor.svelte';
  import type { SelectOption } from '../../api/client';

  const options = $derived(getFilterOptions());
  const filters = $derived(getFilters());

  interface Props {
    onchange: (filters: Record<string, string>) => void;
  }
  let { onchange }: Props = $props();

  function handleChange(key: string, value: string) {
    const next = { ...filters };
    if (value) {
      next[key] = value;
    } else {
      delete next[key];
    }
    setFilters(next);
    onchange(next);
  }

  function optionValue(option: string | SelectOption): string {
    return typeof option === 'string' ? option : option.value;
  }

  function optionLabel(option: string | SelectOption): string {
    return typeof option === 'string' ? option : option.label;
  }

  const filterDefs: Array<{ key: string; label: string; allLabel?: string; optionsKey: keyof typeof options }> = [
    { key: 'agent_type', label: 'Agent', optionsKey: 'agent_types' },
    { key: 'event_type', label: 'Event', optionsKey: 'event_types' },
    { key: 'tool_name', label: 'Tool', optionsKey: 'tool_names' },
    { key: 'model', label: 'Model', optionsKey: 'models' },
    { key: 'project', label: 'Project', optionsKey: 'projects' },
    { key: 'branch', label: 'Branch', allLabel: 'All Branches', optionsKey: 'branches' },
    { key: 'source', label: 'Source', optionsKey: 'sources' },
  ];
</script>

<div class="flex items-center gap-2 flex-wrap">
  {#each filterDefs as def}
    {@const opts = options[def.optionsKey] as Array<string | SelectOption> || []}
    {#if opts.length > 0}
      <select
        class="rounded-sm border border-line bg-surface px-2.5 py-1.5 text-meta text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
        value={filters[def.key] || ''}
        onchange={(e) => handleChange(def.key, (e.target as HTMLSelectElement).value)}
      >
        <option value="">{def.allLabel || `All ${def.label}s`}</option>
        {#each opts as opt}
          <option value={optionValue(opt)}>{optionLabel(opt)}</option>
        {/each}
      </select>
    {/if}
  {/each}
  {#if Object.keys(filters).length > 0}
    <button
      class="text-meta text-text-muted transition-colors hover:text-text"
      onclick={() => { setFilters({}); onchange({}); }}
    >Clear</button>
  {/if}
</div>
