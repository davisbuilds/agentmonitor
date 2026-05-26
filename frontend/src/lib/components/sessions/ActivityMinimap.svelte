<script lang="ts">
  import type { SessionActivity, SessionActivityBucket } from '../../api/client';
  import { formatNumber } from '../../format';

  interface Props {
    activity: SessionActivity | null;
    loading: boolean;
    error: string | null;
    activeBucketIndex: number | null;
    onselect: (bucket: SessionActivityBucket) => void;
  }

  let {
    activity,
    loading,
    error,
    activeBucketIndex,
    onselect,
  }: Props = $props();

  const maxBucketMessages = $derived.by(() => {
    if (!activity) return 1;
    return Math.max(...activity.data.map(bucket => bucket.message_count), 1);
  });

  function bucketTone(bucket: SessionActivityBucket): string {
    if (bucket.message_count === 0) return 'bg-surface-2';
    const ratio = bucket.message_count / maxBucketMessages;
    if (ratio > 0.66) return 'bg-accent';
    if (ratio > 0.33) return 'bg-accent/80';
    return 'bg-accent/55';
  }

  const basisLabel = $derived.by(() => {
    if (!activity) return '';
    switch (activity.navigation_basis) {
      case 'timestamp':
        return 'Timestamp-based';
      case 'mixed':
        return 'Mixed timestamp coverage';
      default:
        return 'Ordinal-based';
    }
  });
</script>

<section class="rounded-lg border border-line bg-surface p-3">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h3 class="text-meta font-semibold uppercase tracking-wide text-text-muted">Activity Map</h3>
      <p class="mt-1 text-meta text-text-faint">Jump through long transcripts by bucket.</p>
    </div>
    {#if activity}
      <span class="text-meta text-text-faint">{basisLabel}</span>
    {/if}
  </div>

  {#if loading}
    <div class="mt-3 h-20 animate-pulse rounded-sm bg-surface-2"></div>
  {:else if error}
    <div class="mt-3 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-meta text-danger">
      {error}
    </div>
  {:else if activity && activity.data.length > 0}
    <div class="mt-3">
      <div class="flex h-16 items-end gap-1 lg:hidden">
        {#each activity.data as bucket}
          <button
            class={`min-w-0 flex-1 rounded-t-sm transition ${activeBucketIndex === bucket.bucket_index ? 'ring-1 ring-accent' : ''} ${bucketTone(bucket)}`}
            style={`height:${Math.max((bucket.message_count / maxBucketMessages) * 100, bucket.message_count > 0 ? 10 : 4)}%`}
            title={`Messages ${bucket.start_ordinal ?? 0}–${bucket.end_ordinal ?? 0} (${bucket.message_count})`}
            onclick={() => onselect(bucket)}
          >
            <span class="sr-only">Jump to bucket {bucket.bucket_index + 1}</span>
          </button>
        {/each}
      </div>

      <div class="hidden h-full max-h-[26rem] min-h-[16rem] flex-col gap-1 lg:flex">
        {#each activity.data as bucket}
          <button
            class={`w-full flex-1 rounded-sm transition ${activeBucketIndex === bucket.bucket_index ? 'ring-1 ring-accent' : ''} ${bucketTone(bucket)}`}
            title={`Messages ${bucket.start_ordinal ?? 0}–${bucket.end_ordinal ?? 0} (${bucket.message_count})`}
            onclick={() => onselect(bucket)}
          >
            <span class="sr-only">Jump to bucket {bucket.bucket_index + 1}</span>
          </button>
        {/each}
      </div>

      <div class="mt-3 flex items-center justify-between text-meta text-text-faint">
        <span class="tabular font-mono">{formatNumber(activity.total_messages)} msgs</span>
        <span class="tabular font-mono">
          {activity.data[0]?.start_ordinal ?? 0}–{activity.data.at(-1)?.end_ordinal ?? 0}
        </span>
      </div>
      {#if activity.untimestamped_messages > 0}
        <p class="mt-2 text-meta text-warn">
          {formatNumber(activity.untimestamped_messages)} message{activity.untimestamped_messages === 1 ? '' : 's'} lack timestamps, so some navigation falls back to ordinal position.
        </p>
      {/if}
    </div>
  {:else}
    <div class="mt-3 rounded-sm border border-dashed border-line px-3 py-8 text-center text-meta text-text-faint">
      No transcript activity available.
    </div>
  {/if}
</section>
