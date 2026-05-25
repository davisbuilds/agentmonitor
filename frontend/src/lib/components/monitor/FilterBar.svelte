<script lang="ts">
  import { getFilterOptions, getFilters, setFilters } from '../../stores/monitor.svelte';
  import type { SelectOption } from '../../api/client';
  import { Select, Popover, Button, Field } from '../ui';

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

  interface FilterDef {
    key: string;
    label: string;
    allLabel?: string;
    optionsKey:
      | 'agent_types'
      | 'event_types'
      | 'tool_names'
      | 'models'
      | 'projects'
      | 'branches'
      | 'sources';
  }

  // Primary filters stay inline; the rest collapse into a "Filters" popover.
  const primaryDefs: FilterDef[] = [
    { key: 'agent_type', label: 'Agent', optionsKey: 'agent_types' },
    { key: 'event_type', label: 'Event', optionsKey: 'event_types' },
    { key: 'tool_name', label: 'Tool', optionsKey: 'tool_names' },
  ];
  const overflowDefs: FilterDef[] = [
    { key: 'model', label: 'Model', optionsKey: 'models' },
    { key: 'project', label: 'Project', optionsKey: 'projects' },
    { key: 'branch', label: 'Branch', allLabel: 'All Branches', optionsKey: 'branches' },
    { key: 'source', label: 'Source', optionsKey: 'sources' },
  ];

  function optionsFor(def: FilterDef): Array<string | SelectOption> {
    return (options[def.optionsKey] as Array<string | SelectOption>) || [];
  }
  function placeholderFor(def: FilterDef): string {
    return def.allLabel || `All ${def.label}s`;
  }

  const overflowHasOptions = $derived(overflowDefs.some((def) => optionsFor(def).length > 0));
  const activeOverflow = $derived(overflowDefs.filter((def) => filters[def.key]).length);
  const activeCount = $derived(Object.keys(filters).length);
</script>

<div class="flex flex-wrap items-center gap-2">
  {#each primaryDefs as def}
    {#if optionsFor(def).length > 0}
      <Select
        value={filters[def.key] || ''}
        options={optionsFor(def)}
        placeholder={placeholderFor(def)}
        aria-label={def.label}
        onchange={(value) => handleChange(def.key, value)}
      />
    {/if}
  {/each}

  {#if overflowHasOptions}
    <Popover align="left" width="w-64" label="More filters">
      {#snippet trigger({ toggle, open })}
        <Button variant="neutral" size="sm" aria-label="More filters" onclick={toggle}>
          Filters
          {#if activeOverflow > 0}
            <span class="tabular rounded-full bg-accent/15 px-1.5 text-accent">{activeOverflow}</span>
          {/if}
          <svg
            class="h-3 w-3 text-text-faint transition-transform {open ? 'rotate-180' : ''}"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </Button>
      {/snippet}

      <div class="space-y-3">
        {#each overflowDefs as def}
          {#if optionsFor(def).length > 0}
            <Field label={def.label}>
              <Select
                value={filters[def.key] || ''}
                options={optionsFor(def)}
                placeholder={placeholderFor(def)}
                aria-label={def.label}
                class="w-full"
                onchange={(value) => handleChange(def.key, value)}
              />
            </Field>
          {/if}
        {/each}
      </div>
    </Popover>
  {/if}

  {#if activeCount > 0}
    <Button variant="ghost" size="sm" onclick={() => { setFilters({}); onchange({}); }}>Clear</Button>
  {/if}
</div>
