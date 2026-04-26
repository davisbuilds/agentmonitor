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
  class="group relative inline-flex h-8 w-8 items-center justify-center"
  role="status"
  aria-label={label}
  title={label}
>
  <span class="h-2.5 w-2.5 rounded-full {dotClass}"></span>
  <span class="pointer-events-none absolute right-0 top-full z-50 mt-2 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
    {label}
  </span>
</span>
