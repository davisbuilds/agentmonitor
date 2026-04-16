<script lang="ts">
  import { onMount } from 'svelte';
  import { pins } from '../../stores/pins.svelte';
  import { getMessagePreviewText, getSessionPreviewText } from '../../session-text';
  import { timeAgo, agentHexColor } from '../../format';

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
  <div class="flex h-full flex-col rounded-2xl border border-gray-800 bg-gray-950/30">
    <div class="border-b border-gray-800 px-4 py-4 sm:px-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold text-gray-100">Pinned Messages</h2>
          <p class="mt-1 text-sm text-gray-500">Save important transcript moments and reopen them at the exact message.</p>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs text-gray-500">{pins.pins.length} pinned</span>
          <select
            class="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-300"
            value={pins.project}
            onchange={(event) => pins.setProject((event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">All Projects</option>
            {#each pins.projectOptions as project}
              <option value={project}>{project}</option>
            {/each}
          </select>
        </div>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      {#if pins.loading}
        <div class="py-16 text-center text-sm text-gray-500">Loading pinned messages...</div>
      {:else if pins.error}
        <div class="py-16 text-center text-sm text-red-300">{pins.error}</div>
      {:else if pins.pins.length === 0}
        <div class="flex h-full items-center justify-center rounded-xl border border-dashed border-gray-800 px-6 py-16 text-center">
          <div>
            <p class="text-sm text-gray-300">No pinned messages yet.</p>
            <p class="mt-2 text-xs text-gray-500">Open any session and use the pin control on a message header to save it here.</p>
          </div>
        </div>
      {:else}
        <div class="space-y-3">
          {#each pins.pins as pin (pin.id)}
            <article class="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-2">
                    <span
                      class="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={`background-color:${agentHexColor(pin.session_agent ?? 'unknown')}`}
                    ></span>
                    <span class="truncate text-sm font-medium text-gray-100">
                      {preview(pin)}
                    </span>
                  </div>
                  <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                    <span>{pin.session_project ?? 'unknown project'}</span>
                    <span>{pin.session_agent ?? 'unknown agent'}</span>
                    <span>msg #{pin.message_ordinal}</span>
                    <span>{timeAgo(pin.created_at)}</span>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <button
                    class="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-200 transition hover:border-gray-500 hover:text-white"
                    onclick={() => pins.openPin(pin.session_id, pin.message_ordinal)}
                  >
                    Open In Session
                  </button>
                  {#if pin.message_id != null}
                    <button
                      class="rounded border border-amber-700/50 px-3 py-1.5 text-xs text-amber-200 transition hover:border-amber-500 hover:text-amber-100"
                      onclick={() => pins.unpin(pin.session_id, pin.message_id as number)}
                    >
                      Unpin
                    </button>
                  {/if}
                </div>
              </div>

              {#if pin.content}
                <div class="mt-3 rounded-lg border border-gray-800 bg-gray-950/40 px-3 py-3 text-sm text-gray-300">
                  {preview(pin)}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</main>
