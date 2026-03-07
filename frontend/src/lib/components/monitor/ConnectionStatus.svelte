<script lang="ts">
  import { getConnectionStatus } from '../../stores/monitor.svelte';

  const status = $derived(getConnectionStatus());
  const dotClass = $derived(
    status === 'connected' ? 'bg-green-400' :
    status === 'connecting' ? 'bg-yellow-400 animate-pulse' :
    'bg-red-400'
  );
  const textClass = $derived(
    status === 'connected' ? 'text-green-400' :
    status === 'connecting' ? 'text-yellow-400' :
    'text-red-400'
  );
  const label = $derived(
    status === 'connected' ? 'Connected' :
    status === 'connecting' ? 'Connecting...' :
    'Disconnected'
  );
</script>

<div class="flex items-center gap-2 text-sm text-gray-400">
  <span class="w-2 h-2 rounded-full {dotClass}"></span>
  <span class="{textClass}">{label}</span>
</div>
