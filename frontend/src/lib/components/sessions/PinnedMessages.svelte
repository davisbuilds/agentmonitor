<script lang="ts">
  import type { PinnedMessage } from '../../api/client';
  import { agentHexColor, timeAgo } from '../../format';
  import { pinnedMessagePreview } from '../../sessions-browse';
  import { sessionTitle } from '../../session-text';
  import { pins } from '../../stores/pins.svelte';
  import { Button, EmptyState } from '../ui';

  interface Props {
    /** The pins the Sessions filters select (`filterPinnedMessages`). */
    visible: PinnedMessage[];
    onopen: (pin: PinnedMessage) => void;
  }

  let { visible, onopen }: Props = $props();
</script>

{#if pins.loading && pins.pins.length === 0}
  <div class="py-16 text-center text-meta text-text-muted">Loading pinned messages…</div>
{:else if pins.error}
  <div class="py-16 text-center text-meta text-danger">{pins.error}</div>
{:else if pins.pins.length === 0}
  <EmptyState
    title="No pinned messages yet."
    description="Open any session and use the pin control on a message header to save it here."
  />
{:else if visible.length === 0}
  <EmptyState title="No pinned messages match the current filters." />
{:else}
  <div class="space-y-2">
    {#each visible as pin (pin.id)}
      <div class="flex items-start gap-2">
        <button
          class="min-w-0 flex-1 rounded-sm border border-line bg-surface px-3 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
          onclick={() => onopen(pin)}
        >
          <div class="mb-1 flex items-center justify-between gap-3 text-meta text-text-faint">
            <div class="min-w-0 flex items-center gap-2">
              <span
                class="inline-block h-2 w-2 shrink-0 rounded-full"
                style={`background-color:${agentHexColor(pin.session_agent ?? 'unknown')}`}
              ></span>
              <span class="truncate">{pin.session_project || pin.session_agent || 'unknown project'}</span>
              <span>·</span>
              <span class="tabular font-mono">msg #{pin.message_ordinal}</span>
            </div>
            <div class="shrink-0 tabular font-mono">pinned {timeAgo(pin.created_at)}</div>
          </div>
          <div class="text-body text-text line-clamp-2">{pinnedMessagePreview(pin)}</div>
          <div class="mt-2 truncate text-meta text-text-faint">
            {sessionTitle({ title: pin.session_title, first_message: pin.session_first_message, agent: pin.session_agent })}
          </div>
        </button>
        {#if pin.message_id != null}
          <Button variant="ghost" size="sm" class="mt-2" onclick={() => pins.unpin(pin.session_id, pin.message_id as number)}>
            Unpin
          </Button>
        {/if}
      </div>
    {/each}
  </div>
{/if}
