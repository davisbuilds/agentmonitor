<script lang="ts">
  import { getSelectedSessionId, setSelectedSessionId } from '../../stores/monitor.svelte';
  import { fetchSessionDetail, fetchTranscript, type AgentEvent } from '../../api/client';
  import { timeAgo, formatDuration, agentColor } from '../../format';
  import { StatusDot, Badge } from '../ui';

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
  <div class="fixed inset-0 z-50">
    <button class="absolute inset-0 bg-black/50" onclick={close} aria-label="Close"></button>
    <div class="fixed inset-y-0 right-0 w-full max-w-lg overflow-y-auto border-l border-line bg-surface p-6 shadow-overlay">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-h3">Session Details</h2>
        <button
          class="rounded-sm p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
          aria-label="Close"
          onclick={close}
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      {#if loading}
        <div class="text-meta text-text-muted">Loading…</div>
      {:else if session}
        <div class="space-y-5">
          <!-- Metadata -->
          <div class="space-y-2 text-meta">
            <div class="flex justify-between gap-3">
              <span class="text-text-muted">Status</span>
              <StatusDot status={session.status as string} label={session.status as string} />
            </div>
            <div class="flex justify-between gap-3">
              <span class="text-text-muted">Agent</span>
              <span class={agentColor(session.agent_type as string)}>{session.agent_type}</span>
            </div>
            {#if session.mode === 'headless' || session.mode === 'interactive'}
              <div class="flex justify-between gap-3">
                <span class="text-text-muted">Mode</span>
                {#if session.mode === 'headless'}
                  <Badge tone="neutral" title="Headless run (claude -p / codex exec)">headless</Badge>
                {:else}
                  <span class="text-text">interactive</span>
                {/if}
              </div>
            {/if}
            {#if session.project}
              <div class="flex justify-between gap-3">
                <span class="text-text-muted">Project</span>
                <span class="truncate text-text">{session.project}</span>
              </div>
            {/if}
            <div class="flex justify-between gap-3">
              <span class="text-text-muted">Started</span>
              <span class="text-text">{timeAgo(session.started_at as string)}</span>
            </div>
            <div class="flex justify-between gap-3">
              <span class="text-text-muted">Session ID</span>
              <span class="truncate font-mono text-meta text-text-faint">{sessionId}</span>
            </div>
          </div>

          <!-- Transcript -->
          {#if transcript.length > 0}
            <div>
              <h3 class="mb-2 text-meta font-medium text-text-muted">Transcript</h3>
              <div class="max-h-96 space-y-2 overflow-y-auto">
                {#each transcript as msg}
                  <div class="rounded-sm p-2 text-meta {msg.role === 'user' ? 'bg-surface-2' : 'bg-surface-2/50'}">
                    <span class="font-medium {msg.role === 'user' ? 'text-accent' : 'text-ok'}">{msg.role}</span>
                    <p class="mt-1 whitespace-pre-wrap break-words text-text">{msg.content}</p>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Recent Events -->
          {#if events.length > 0}
            <div>
              <h3 class="mb-2 text-meta font-medium text-text-muted">Recent Events</h3>
              <div class="space-y-1">
                {#each events as event}
                  <div class="flex items-center gap-2 text-meta text-text-muted">
                    <span class="text-text">{event.event_type}{event.tool_name ? ` › ${event.tool_name}` : ''}</span>
                    {#if event.duration_ms}<span class="tabular font-mono text-text-faint">{formatDuration(event.duration_ms)}</span>{/if}
                    <span class="ml-auto text-text-faint">{timeAgo(event.created_at)}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="text-meta text-text-muted">Session not found</div>
      {/if}
    </div>
  </div>
{/if}
