<script lang="ts" generics="Row">
  import type { Snippet } from 'svelte';

  interface Column {
    key: string;
    label: string;
    /** Right-aligns the column and renders cells in tabular mono. */
    numeric?: boolean;
    align?: 'left' | 'right';
    /** CSS width value, e.g. '8rem'. */
    width?: string;
  }

  interface Props {
    columns: Column[];
    rows: Row[];
    rowKey: (row: Row, index: number) => string | number;
    /** Custom cell renderer; falls back to row[column.key]. */
    cell?: Snippet<[Row, Column]>;
    onrowclick?: (row: Row) => void;
    empty?: string;
    stickyHeader?: boolean;
    class?: string;
  }

  let {
    columns,
    rows,
    rowKey,
    cell,
    onrowclick,
    empty = 'No data.',
    stickyHeader = true,
    class: klass = '',
  }: Props = $props();

  function cellValue(row: Row, column: Column): string | number | null | undefined {
    return (row as Record<string, unknown>)[column.key] as string | number | null | undefined;
  }

  function alignClass(column: Column): string {
    return column.numeric || column.align === 'right' ? 'text-right' : 'text-left';
  }
</script>

<div class="overflow-x-auto {klass}">
  <table class="w-full border-collapse text-body">
    <thead class={stickyHeader ? 'sticky top-0 z-10 bg-surface' : ''}>
      <tr class="border-b border-line">
        {#each columns as column}
          <th
            class="px-3 py-2 text-meta font-medium text-text-muted {alignClass(column)}"
            style={column.width ? `width:${column.width}` : undefined}
          >
            {column.label}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if rows.length === 0}
        <tr>
          <td colspan={columns.length} class="px-3 py-8 text-center text-meta text-text-muted">{empty}</td>
        </tr>
      {:else}
        {#each rows as row, index (rowKey(row, index))}
          <tr
            class="border-b border-line/60 last:border-0 {onrowclick ? 'cursor-pointer hover:bg-surface-2' : ''}"
            onclick={onrowclick ? () => onrowclick(row) : undefined}
          >
            {#each columns as column}
              <td
                class="px-3 py-2.5 {column.numeric ? 'tabular text-right font-mono text-text' : 'text-text-muted'}"
              >
                {#if cell}{@render cell(row, column)}{:else}{cellValue(row, column) ?? '—'}{/if}
              </td>
            {/each}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>
