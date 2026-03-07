<script lang="ts">
  import { getSelectedSessionId, setSelectedSessionId } from '../../stores/monitor.svelte';
  import { fetchSessionDetail, fetchTranscript, type AgentEvent } from '../../api/client';
  import { formatCost, formatNumber, timeAgo, formatDuration, statusColor, agentColor } from '../../format';

  const sessionId = $derived(getSelectedSessionId());
  let loading = $state(false);
  let session = $state<Record<string, unknown> | null>(null);
  let events = $state<AgentEvent[]>([]);
  let transcript = $state<Array<{ role: string; content: string; timestamp?: string }>>([]);

  $effect(() => {
    if (sessionId) {
      loadSession(sessionId);
    } else {
      session = null;
      events = [];
      transcript = [];
    }
  });

  async function loadSession(id: string) {
    loading = true;
    try {
      const [detailRes, transcriptRes] = await Promise.all([
        fetchSessionDetail(id, 50),
        fetchTranscript(id).catch(() => ({ transcript: [] })),
      ]);
      session = detailRes.session as unknown as Record<string, unknown>;
      events = detailRes.events;
      transcript = transcriptRes.transcript || [];
    } catch {
      session = null;
    } finally {
      loading = false;
    }
  }

  function close() {
    setSelectedSessionId(null);
  }
</script>

{#if sessionId}
  <!-- Backdrop -->
  <div class="fixed inset-0 z-50 flex justify-start">
    <button class="absolute inset-0 bg-black/50" onclick={close} aria-label="Close"></button>
    <div class="relative w-full max-w-lg bg-gray-900 border-r border-gray-700 overflow-y-auto p-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">Session Details</h2>
        <button class="text-gray-400 hover:text-white transition-colors text-lg" onclick={close}>&times;</button>
      </div>

      {#if loading}
        <div class="text-gray-500 text-sm">Loading...</div>
      {:else if session}
        <div class="space-y-4">
          <!-- Metadata -->
          <div class="space-y-2 text-xs">
            <div class="flex justify-between">
              <span class="text-gray-400">Status</span>
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full {statusColor(session.status as string)}"></span>
                <span class="text-white">{session.status}</span>
              </div>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">Agent</span>
              <span class="{agentColor(session.agent_type as string)}">{session.agent_type}</span>
            </div>
            {#if session.project}
              <div class="flex justify-between">
                <span class="text-gray-400">Project</span>
                <span class="text-white">{session.project}</span>
              </div>
            {/if}
            <div class="flex justify-between">
              <span class="text-gray-400">Started</span>
              <span class="text-white">{timeAgo(session.started_at as string)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">Session ID</span>
              <span class="text-gray-500 text-[10px] font-mono">{sessionId}</span>
            </div>
          </div>

          <!-- Transcript -->
          {#if transcript.length > 0}
            <div>
              <h3 class="text-xs font-semibold text-gray-400 uppercase mb-2">Transcript</h3>
              <div class="space-y-2 max-h-96 overflow-y-auto">
                {#each transcript as msg}
                  <div class="text-xs p-2 rounded {msg.role === 'user' ? 'bg-gray-800' : 'bg-gray-800/50'}">
                    <span class="font-medium {msg.role === 'user' ? 'text-blue-400' : 'text-green-400'}">{msg.role}</span>
                    <p class="text-gray-300 mt-1 whitespace-pre-wrap break-words">{msg.content}</p>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Recent Events -->
          {#if events.length > 0}
            <div>
              <h3 class="text-xs font-semibold text-gray-400 uppercase mb-2">Recent Events</h3>
              <div class="space-y-1">
                {#each events as event}
                  <div class="text-xs flex items-center gap-2 text-gray-400">
                    <span class="text-gray-300">{event.event_type}{event.tool_name ? ` > ${event.tool_name}` : ''}</span>
                    {#if event.duration_ms}<span class="text-gray-600">{formatDuration(event.duration_ms)}</span>{/if}
                    <span class="text-gray-600 ml-auto">{timeAgo(event.created_at)}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="text-gray-500 text-sm">Session not found</div>
      {/if}
    </div>
  </div>
{/if}
