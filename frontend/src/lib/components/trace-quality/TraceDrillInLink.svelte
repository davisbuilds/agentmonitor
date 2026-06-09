<script lang="ts">
  import { buildAnalyticsQualityHash } from '../../route-state';

  interface Props {
    sessionId: string;
    label?: string;
    class?: string;
  }

  let { sessionId, label = 'Quality ↗', class: klass = '' }: Props = $props();
</script>

<a
  href={`#${buildAnalyticsQualityHash({ sessionId })}`}
  class={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-meta text-accent transition-colors hover:bg-accent/15 ${klass}`}
  title="Inspect this session's traces in the Quality explorer"
  onclick={(e) => e.stopPropagation()}
>{label}</a>
