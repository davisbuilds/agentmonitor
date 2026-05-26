<script lang="ts">
  import { onMount } from 'svelte';
  import { pins } from '../../stores/pins.svelte';
  import { getMessagePreviewText, getSessionPreviewText } from '../../session-text';
  import { timeAgo, agentHexColor } from '../../format';
  import { Panel, Select, Button, EmptyState } from '../ui';

  function preview(pin: { content: string | null; session_first_message: string | null }): string {
    return getMessagePreviewText({ content: pin.content ?? '' })
      || getSessionPreviewText(pin.session_first_message)
      || 'Pinned transcript moment';
  }

  onMount(() => {
    void pins.initialize();
  });
</script>

<main class="flex-1 overflow-hidden p-4 sm:p-6">
  <Panel class="flex h-full flex-col" padded={false}>
    {#snippet header()}
      <div class="min-w-0">
        <h2 class="text-h3">Pinned Messages</h2>
        <p class="mt-0.5 text-meta text-text-muted">Save important transcript moments and reopen them at the exact message.</p>
      </div>
    {/snippet}
    {#snippet actions()}
      <span class="tabular text-meta text-text-faint">{pins.pins.length} pinned</span>
      <Select
        value={pins.project}
        options={pins.projectOptions}
        placeholder="All Projects"
        aria-label="Filter by project"
        onchange={(value) => pins.setProject(value)}
      />
    {/snippet}

    <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
      {#if pins.loading}
        <div class="py-16 text-center text-meta text-text-muted">Loading pinned messages…</div>
      {:else if pins.error}
        <div class="py-16 text-center text-meta text-danger">{pins.error}</div>
      {:else if pins.pins.length === 0}
        <EmptyState
          title="No pinned messages yet."
          description="Open any session and use the pin control on a message header to save it here."
        />
      {:else}
        <div class="space-y-3">
          {#each pins.pins as pin (pin.id)}
            <article class="rounded-lg border border-line bg-surface-2 px-4 py-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-2">
                    <span
                      class="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={`background-color:${agentHexColor(pin.session_agent ?? 'unknown')}`}
                    ></span>
                    <span class="truncate text-body font-medium text-text">
                      {preview(pin)}
                    </span>
                  </div>
                  <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-meta text-text-faint">
                    <span>{pin.session_project ?? 'unknown project'}</span>
                    <span>{pin.session_agent ?? 'unknown agent'}</span>
                    <span class="tabular font-mono">msg #{pin.message_ordinal}</span>
                    <span class="tabular font-mono">{timeAgo(pin.created_at)}</span>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <Button variant="neutral" size="sm" onclick={() => pins.openPin(pin.session_id, pin.message_ordinal)}>
                    Open In Session
                  </Button>
                  {#if pin.message_id != null}
                    <Button variant="ghost" size="sm" onclick={() => pins.unpin(pin.session_id, pin.message_id as number)}>
                      Unpin
                    </Button>
                  {/if}
                </div>
              </div>

              {#if pin.content}
                <div class="mt-3 rounded-sm border border-line bg-surface px-3 py-3 text-body text-text-muted">
                  {preview(pin)}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </div>
  </Panel>
</main>
