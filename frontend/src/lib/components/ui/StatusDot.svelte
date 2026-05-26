<script lang="ts">
  interface Props {
    /** active | idle | ended | error | connected | connecting | disconnected */
    status: string;
    label?: string;
    pulse?: boolean;
    class?: string;
  }

  let { status, label, pulse = false, class: klass = '' }: Props = $props();

  const colors: Record<string, string> = {
    active: 'bg-ok',
    connected: 'bg-ok',
    idle: 'bg-warn',
    connecting: 'bg-warn',
    ended: 'bg-line-strong',
    disconnected: 'bg-danger',
    error: 'bg-danger',
  };

  const color = $derived(colors[status] ?? 'bg-line-strong');
</script>

<span class="inline-flex items-center gap-1.5 {klass}">
  <span class="h-2 w-2 rounded-full {color} {pulse ? 'animate-pulse' : ''}"></span>
  {#if label}<span class="text-meta text-text-muted">{label}</span>{/if}
</span>
