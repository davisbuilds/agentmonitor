<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { BrowsingSession, SearchResult } from '../../api/client';
  import { agentHexColor, timeAgo } from '../../format';
  import { getSessionPreviewText } from '../../session-text';
  import { closeCommandPalette } from '../../stores/router.svelte';
  import { commandPaletteSearch } from '../../stores/search.svelte';

  type PaletteItem =
    | { key: string; kind: 'session'; session: BrowsingSession }
    | { key: string; kind: 'result'; result: SearchResult };

  let inputRef = $state<HTMLInputElement | undefined>(undefined);
  let selectedIndex = $state(0);

  function sanitizeSnippet(html: string): string {
    return html
      .replace(/<mark>/g, '\x00MARK_OPEN\x00')
      .replace(/<\/mark>/g, '\x00MARK_CLOSE\x00')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\x00MARK_OPEN\x00/g, '<mark>')
      .replace(/\x00MARK_CLOSE\x00/g, '</mark>');
  }

  function sessionPreview(session: { first_message: string | null; message_count: number; id: string }): string {
    return getSessionPreviewText(session.first_message)
      || (session.message_count > 0 ? 'Local command activity' : session.id.slice(0, 12));
  }

  const paletteItems = $derived.by<PaletteItem[]>(() => {
    if (commandPaletteSearch.hasQuery) {
      return commandPaletteSearch.results.map((result) => ({
        key: `${result.session_id}:${result.message_id}`,
        kind: 'result' as const,
        result,
      }));
    }

    return commandPaletteSearch.recentSessions.map((session) => ({
      key: session.id,
      kind: 'session' as const,
      session,
    }));
  });

  const footerText = $derived.by(() => {
    if (!commandPaletteSearch.hasQuery) {
      return 'Recent sessions';
    }
    if (commandPaletteSearch.loading) {
      return 'Searching transcript history';
    }
    return `Showing ${commandPaletteSearch.results.length} of ${commandPaletteSearch.total} transcript matches`;
  });

  function closePalette(): void {
    commandPaletteSearch.reset();
    closeCommandPalette();
  }

  function handleInput(event: Event): void {
    selectedIndex = 0;
    commandPaletteSearch.setQuery((event.currentTarget as HTMLInputElement).value);
  }

  function selectItem(item: PaletteItem | undefined): void {
    if (!item) return;

    if (item.kind === 'result') {
      commandPaletteSearch.openResult(item.result);
      return;
    }

    commandPaletteSearch.openSession(item.session.id);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (paletteItems.length === 0) return;
      selectedIndex = Math.min(selectedIndex + 1, paletteItems.length - 1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (paletteItems.length === 0) return;
      selectedIndex = Math.max(selectedIndex - 1, 0);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      selectItem(paletteItems[selectedIndex]);
    }
  }

  onMount(() => {
    void commandPaletteSearch.initialize().then(() => tick().then(() => inputRef?.focus()));
    window.addEventListener('keydown', handleKeydown);

    return () => {
      window.removeEventListener('keydown', handleKeydown);
      commandPaletteSearch.cancelPending();
      commandPaletteSearch.reset();
    };
  });

  $effect(() => {
    const maxIndex = Math.max(paletteItems.length - 1, 0);
    if (selectedIndex > maxIndex) {
      selectedIndex = maxIndex;
    }
  });

  $effect(() => {
    const selectedKey = paletteItems[selectedIndex]?.key;
    if (!selectedKey) return;

    tick().then(() => {
      const selected = document.querySelector<HTMLElement>('[data-palette-selected="true"]');
      selected?.scrollIntoView({ block: 'nearest' });
    });
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 bg-gray-950/80 px-4 py-[12vh] backdrop-blur-sm sm:px-6"
  tabindex="-1"
  onclick={(event) => {
    if (event.target === event.currentTarget) {
      closePalette();
    }
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      closePalette();
    }
  }}
>
  <div class="mx-auto flex max-h-[72vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-950 shadow-2xl">
    <div class="border-b border-gray-800 px-4 py-4 sm:px-5">
      <div class="flex items-center gap-3">
        <input
          bind:this={inputRef}
          type="text"
          placeholder="Jump to a session or transcript match..."
          class="w-full rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-sm text-gray-100 outline-none transition focus:border-blue-500"
          oninput={handleInput}
        />
        <button
          type="button"
          class="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400 transition hover:border-gray-600 hover:text-gray-200"
          onclick={closePalette}
        >
          Esc
        </button>
      </div>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div class="text-xs text-gray-500">{footerText}</div>

        {#if commandPaletteSearch.hasQuery}
          <div class="inline-flex rounded-lg border border-gray-700 bg-gray-900 p-1 text-xs">
            <button
              type="button"
              class={`rounded-md px-2.5 py-1 transition ${commandPaletteSearch.sort === 'recent' ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
              onclick={() => {
                selectedIndex = 0;
                commandPaletteSearch.setSort('recent');
              }}
            >
              Recent
            </button>
            <button
              type="button"
              class={`rounded-md px-2.5 py-1 transition ${commandPaletteSearch.sort === 'relevance' ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
              onclick={() => {
                selectedIndex = 0;
                commandPaletteSearch.setSort('relevance');
              }}
            >
              Relevance
            </button>
          </div>
        {/if}
      </div>
    </div>

    <div class="min-h-[320px] overflow-y-auto p-2">
      {#if commandPaletteSearch.hasQuery && commandPaletteSearch.loading && commandPaletteSearch.results.length === 0}
        <div class="px-3 py-14 text-center text-sm text-gray-500">Searching transcript history...</div>
      {:else if commandPaletteSearch.hasQuery && commandPaletteSearch.error}
        <div class="px-3 py-14 text-center text-sm text-red-300">{commandPaletteSearch.error}</div>
      {:else if !commandPaletteSearch.hasQuery && commandPaletteSearch.recentError}
        <div class="px-3 py-14 text-center text-sm text-red-300">{commandPaletteSearch.recentError}</div>
      {:else if paletteItems.length === 0}
        <div class="px-3 py-14 text-center text-sm text-gray-500">
          {commandPaletteSearch.hasQuery ? 'No transcript matches found.' : 'No recent sessions available.'}
        </div>
      {:else}
        <div class="space-y-1">
          {#each paletteItems as item, index (item.key)}
            {#if item.kind === 'result'}
              <button
                type="button"
                class={`w-full rounded-xl border px-3 py-3 text-left transition ${index === selectedIndex ? 'border-blue-500/60 bg-blue-500/10' : 'border-transparent bg-gray-900/50 hover:border-gray-700 hover:bg-gray-900'}`}
                data-palette-selected={index === selectedIndex ? 'true' : 'false'}
                onclick={() => selectItem(item)}
                onmouseenter={() => {
                  selectedIndex = index;
                }}
              >
                <div class="flex items-center justify-between gap-3 text-xs text-gray-500">
                  <div class="flex min-w-0 items-center gap-2">
                    <span
                      class="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={`background-color:${agentHexColor(item.result.session_agent)}`}
                    ></span>
                    <span class="truncate">{item.result.session_project || item.result.session_agent}</span>
                    <span>·</span>
                    <span>{item.result.message_role}</span>
                    <span>·</span>
                    <span>msg #{item.result.message_ordinal}</span>
                  </div>
                  <div class="shrink-0">
                    {#if item.result.session_started_at}
                      {timeAgo(item.result.session_started_at)}
                    {:else}
                      {item.result.session_id.slice(0, 8)}
                    {/if}
                  </div>
                </div>
                <div class="mt-2 line-clamp-2 text-sm text-gray-200">
                  {@html sanitizeSnippet(item.result.snippet)}
                </div>
                {#if item.result.session_first_message}
                  <div class="mt-2 truncate text-xs text-gray-500">
                    {getSessionPreviewText(item.result.session_first_message)}
                  </div>
                {/if}
              </button>
            {:else}
              <button
                type="button"
                class={`w-full rounded-xl border px-3 py-3 text-left transition ${index === selectedIndex ? 'border-blue-500/60 bg-blue-500/10' : 'border-transparent bg-gray-900/50 hover:border-gray-700 hover:bg-gray-900'}`}
                data-palette-selected={index === selectedIndex ? 'true' : 'false'}
                onclick={() => selectItem(item)}
                onmouseenter={() => {
                  selectedIndex = index;
                }}
              >
                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0 flex items-center gap-2">
                    <span
                      class="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={`background-color:${agentHexColor(item.session.agent)}`}
                    ></span>
                    <span class="truncate text-sm text-gray-200">{sessionPreview(item.session)}</span>
                  </div>
                  <div class="shrink-0 text-xs text-gray-500">
                    {#if item.session.started_at}
                      {timeAgo(item.session.started_at)}
                    {/if}
                  </div>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span>{item.session.agent}</span>
                  {#if item.session.project}
                    <span>· {item.session.project}</span>
                  {/if}
                  <span>· {item.session.message_count} msgs</span>
                </div>
              </button>
            {/if}
          {/each}
        </div>
      {/if}
    </div>

    <div class="border-t border-gray-800 px-4 py-3 text-xs text-gray-500 sm:px-5">
      Enter to open. Arrow keys move selection. Cmd/Ctrl+K toggles the palette.
    </div>
  </div>
</div>
