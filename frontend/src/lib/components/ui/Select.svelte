<script lang="ts">
  interface SelectOption {
    value: string;
    label: string;
  }

  interface Props {
    value: string;
    options: Array<string | SelectOption>;
    /** When set, renders a leading value="" option (e.g. "All Projects"). */
    placeholder?: string;
    'aria-label'?: string;
    /** Fill the container (popover fields) instead of the capped filter-bar width. */
    fill?: boolean;
    class?: string;
    onchange?: (value: string) => void;
  }

  let {
    value = $bindable(),
    options,
    placeholder,
    'aria-label': ariaLabel,
    fill = false,
    class: klass = '',
    onchange,
  }: Props = $props();

  function normalize(option: string | SelectOption): SelectOption {
    return typeof option === 'string' ? { value: option, label: option } : option;
  }

  // A native select is as wide as its longest option, so one long project or
  // tool name used to stretch it across the bar. Capped, it truncates the
  // shown value, and the tooltip carries the whole of it.
  const selectedLabel = $derived(
    options.map(normalize).find((option) => option.value === value)?.label ?? placeholder ?? '',
  );
</script>

<select
  class="truncate rounded-sm border border-line bg-surface px-2.5 py-1.5 text-meta text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none {fill ? 'w-full' : 'max-w-48'} {klass}"
  bind:value
  aria-label={ariaLabel}
  title={selectedLabel}
  onchange={(event) => onchange?.((event.currentTarget as HTMLSelectElement).value)}
>
  {#if placeholder !== undefined}
    <option value="">{placeholder}</option>
  {/if}
  {#each options as option}
    {@const o = normalize(option)}
    <option value={o.value}>{o.label}</option>
  {/each}
</select>
