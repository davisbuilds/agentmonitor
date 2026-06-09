<script lang="ts">
  import { Badge, Button } from '../ui';
  import type { TraceQualityScore, TraceQualityScoreMutationValue } from '../../api/client';
  import type { ScoreTarget } from '../../stores/trace-quality.svelte';

  type ValueType = 'boolean' | 'numeric' | 'categorical' | 'text';

  interface Props {
    target: ScoreTarget | null;
    scores: TraceQualityScore[];
    saving: boolean;
    error: string | null;
    onadd: (input: { name: string; value_type: ValueType; value: TraceQualityScoreMutationValue; comment: string | null }) => void;
    onremove: (id: number) => void;
  }

  let { target, scores, saving, error, onadd, onremove }: Props = $props();

  let name = $state('');
  let valueType = $state<ValueType>('boolean');
  let booleanValue = $state(true);
  let numericValue = $state('');
  let categoricalValue = $state('');
  let textValue = $state('');
  let comment = $state('');

  const canSubmit = $derived.by(() => {
    if (!target || !name.trim()) return false;
    if (valueType === 'numeric') return numericValue.trim() !== '' && Number.isFinite(Number(numericValue));
    if (valueType === 'categorical') return categoricalValue.trim() !== '';
    if (valueType === 'text') return textValue.trim() !== '';
    return true; // boolean always has a value
  });

  function submit(): void {
    if (!canSubmit) return;
    const value: TraceQualityScoreMutationValue =
      valueType === 'boolean' ? booleanValue
      : valueType === 'numeric' ? Number(numericValue)
      : valueType === 'categorical' ? categoricalValue.trim()
      : textValue.trim();
    onadd({ name: name.trim(), value_type: valueType, value, comment: comment.trim() || null });
    name = '';
    numericValue = '';
    categoricalValue = '';
    textValue = '';
    comment = '';
    booleanValue = true;
  }

  function formatValue(score: TraceQualityScore): string {
    if (score.value_type === 'boolean') return score.boolean_value === 1 ? 'pass' : 'fail';
    if (score.value_type === 'numeric') return score.numeric_value == null ? '—' : String(score.numeric_value);
    if (score.value_type === 'categorical') return score.categorical_value ?? '—';
    return score.text_value ?? '—';
  }

  function valueTone(score: TraceQualityScore): 'ok' | 'danger' | 'neutral' {
    if (score.value_type === 'boolean') return score.boolean_value === 1 ? 'ok' : 'danger';
    return 'neutral';
  }

  const inputClass =
    'rounded-sm border border-line bg-surface px-2 py-1 text-meta text-text transition-colors placeholder:text-text-faint hover:border-line-strong focus:border-accent focus:outline-none';
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between gap-2">
    <h4 class="text-meta font-medium text-text">Local review scores</h4>
    {#if target}
      <span class="text-meta text-text-faint">
        on <span class="text-text-muted">{target.target_type}</span>
      </span>
    {/if}
  </div>

  {#if scores.length > 0}
    <ul class="divide-y divide-line/50 rounded-sm border border-line">
      {#each scores as score (score.id)}
        <li class="flex items-center justify-between gap-2 px-2.5 py-1.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-meta text-text">{score.name}</span>
            <Badge tone={valueTone(score)}>{formatValue(score)}</Badge>
            {#if score.comment}<span class="truncate text-meta text-text-faint" title={score.comment}>{score.comment}</span>{/if}
          </div>
          <button
            type="button"
            class="shrink-0 text-meta text-text-faint transition-colors hover:text-danger"
            onclick={() => onremove(score.id)}
            disabled={saving}
            aria-label={`Delete score ${score.name}`}
          >Remove</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-meta text-text-faint">No local scores on this {target?.target_type ?? 'target'} yet.</p>
  {/if}

  {#if target}
    <div class="space-y-2 rounded-sm border border-line bg-surface-2 p-2.5">
      <div class="flex flex-wrap items-center gap-2">
        <input class={`${inputClass} min-w-[8rem] flex-1`} placeholder="Score name (e.g. correctness)" bind:value={name} />
        <select class={inputClass} bind:value={valueType} aria-label="Value type">
          <option value="boolean">pass/fail</option>
          <option value="numeric">numeric</option>
          <option value="categorical">label</option>
          <option value="text">note</option>
        </select>

        {#if valueType === 'boolean'}
          <div class="flex items-center gap-1">
            <Button variant={booleanValue ? 'primary' : 'ghost'} size="sm" onclick={() => (booleanValue = true)}>Pass</Button>
            <Button variant={!booleanValue ? 'danger' : 'ghost'} size="sm" onclick={() => (booleanValue = false)}>Fail</Button>
          </div>
        {:else if valueType === 'numeric'}
          <input class={`${inputClass} w-24`} type="number" step="any" placeholder="0.0" bind:value={numericValue} />
        {:else if valueType === 'categorical'}
          <input class={`${inputClass} w-32`} placeholder="label" bind:value={categoricalValue} />
        {:else}
          <input class={`${inputClass} min-w-[10rem] flex-1`} placeholder="note" bind:value={textValue} />
        {/if}
      </div>

      <div class="flex items-center gap-2">
        <input class={`${inputClass} min-w-[10rem] flex-1`} placeholder="Optional comment" bind:value={comment} />
        <Button variant="primary" size="sm" onclick={submit} disabled={!canSubmit || saving}>
          {saving ? 'Saving…' : 'Add score'}
        </Button>
      </div>

      {#if error}<p class="text-meta text-danger">{error}</p>{/if}
    </div>
  {/if}
</div>
