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
    class?: string;
    onchange?: (value: string) => void;
  }

  let {
    value = $bindable(),
    options,
    placeholder,
    'aria-label': ariaLabel,
    class: klass = '',
    onchange,
  }: Props = $props();

  function normalize(option: string | SelectOption): SelectOption {
    return typeof option === 'string' ? { value: option, label: option } : option;
  }
</script>

<select
  class="rounded-sm border border-line bg-surface px-2.5 py-1.5 text-meta text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none {klass}"
  bind:value
  aria-label={ariaLabel}
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
