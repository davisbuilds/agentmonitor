<script lang="ts">
  import { getConnectionStatus } from '../../stores/monitor.svelte';

  const status = $derived(getConnectionStatus());
  const dotClass = $derived(
    status === 'connected' ? 'bg-green-400' :
    status === 'connecting' ? 'bg-yellow-400' :
    'bg-red-400'
  );
  const label = $derived(
    status === 'connected' ? 'Connected' :
    status === 'connecting' ? 'Connecting' :
    'Disconnected'
  );
</script>

<span
  class="inline-flex h-2.5 w-2.5 items-center justify-center"
  role="status"
  aria-label={label}
  title={label}
>
  <span class="h-2.5 w-2.5 rounded-full {dotClass}"></span>
</span>
