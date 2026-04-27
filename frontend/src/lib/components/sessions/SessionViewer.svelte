<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import {
    fetchBrowsingSession,
    fetchMessages,
    fetchSessionActivity,
    fetchSessionChildren,
    type BrowsingSession,
    type Message,
    type SessionActivity,
    type SessionActivityBucket,
  } from '../../api/client';
  import { timeAgo, agentHexColor } from '../../format';
  import { getMessagePreviewText, getSessionPreviewText } from '../../session-text';
  import ProjectionCapabilities from '../shared/ProjectionCapabilities.svelte';
  import { hasSessionCapability } from '../../session-capabilities';
  import { pins } from '../../stores/pins.svelte';
  import ActivityMinimap from './ActivityMinimap.svelte';
  import MessageBlock from './MessageBlock.svelte';

  interface Props {
    sessionId: string;
    initialMessageOrdinal?: number | null;
    onclose: () => void;
  }
  let { sessionId, initialMessageOrdinal = null, onclose }: Props = $props();

  let session = $state<BrowsingSession | null>(null);
  let messages = $state<Message[]>([]);
  let children = $state<BrowsingSession[]>([]);
  let totalMessages = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let loadingPrevious = $state(false);
  let loadingMore = $state(false);
  let activity = $state<SessionActivity | null>(null);
  let activityLoading = $state(true);
  let activityError = $state<string | null>(null);
  let activeBucketIndex = $state<number | null>(null);
  let highlightedOrdinal = $state<number | null>(null);
  let transcriptEl = $state<HTMLDivElement | null>(null);
  let pinMutationOrdinal = $state<number | null>(null);
  let sessionPinnedOrdinals = $state<number[]>([]);

  let highlightTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollFrame: number | null = null;

  const PAGE_SIZE = 50;
  const displayTitle = $derived.by(() => {
    for (const message of messages) {
      const preview = getMessagePreviewText(message);
      if (preview) return preview;
    }
    if (!session) return sessionId.slice(0, 12);
    return getSessionPreviewText(session.first_message) || (session.message_count > 0 ? 'Local command activity' : session.id.slice(0, 12));
  });
  const showMinimap = $derived.by(() => activityLoading || !!activityError || ((activity?.data.length ?? 0) > 0));
  const loadedStartOrdinal = $derived(messages[0]?.ordinal ?? null);
  const loadedEndOrdinal = $derived(messages[messages.length - 1]?.ordinal ?? null);
  const hasPreviousMessages = $derived(loadedStartOrdinal != null && loadedStartOrdinal > 0);
  const hasNextMessages = $derived(loadedEndOrdinal != null && totalMessages > 0 && loadedEndOrdinal < totalMessages - 1);

  function clearHighlightTimer() {
    if (highlightTimer) {
      clearTimeout(highlightTimer);
      highlightTimer = null;
    }
  }

  function markHighlightedOrdinal(ordinal: number | null) {
    clearHighlightTimer();
    highlightedOrdinal = ordinal;
    if (ordinal == null) return;
    highlightTimer = setTimeout(() => {
      highlightedOrdinal = null;
      highlightTimer = null;
    }, 2200);
  }

  function findBucketIndexForOrdinal(ordinal: number | null): number | null {
    if (ordinal == null || !activity) return null;
    for (const bucket of activity.data) {
      if (bucket.start_ordinal == null || bucket.end_ordinal == null) continue;
      if (ordinal >= bucket.start_ordinal && ordinal <= bucket.end_ordinal) {
        return bucket.bucket_index;
      }
    }
    return null;
  }

  function syncActiveBucketToViewport() {
    if (!transcriptEl || !activity || messages.length === 0) return;

    const blocks = Array.from(transcriptEl.querySelectorAll<HTMLElement>('[data-message-ordinal]'));
    if (blocks.length === 0) return;

    const containerRect = transcriptEl.getBoundingClientRect();
    const anchorTop = containerRect.top + Math.min(96, Math.max(containerRect.height * 0.18, 40));

    let candidate = blocks[0] ?? null;
    for (const block of blocks) {
      if (block.getBoundingClientRect().top <= anchorTop) {
        candidate = block;
      } else {
        break;
      }
    }

    const ordinal = Number.parseInt(candidate?.dataset.messageOrdinal ?? '', 10);
    activeBucketIndex = Number.isNaN(ordinal) ? null : findBucketIndexForOrdinal(ordinal);
  }

  function scheduleActiveBucketSync() {
    if (typeof window === 'undefined') return;
    if (scrollFrame != null) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = null;
      syncActiveBucketToViewport();
    });
  }

  function handleTranscriptScroll() {
    scheduleActiveBucketSync();
  }

  async function loadWindowAroundOrdinal(targetOrdinal: number): Promise<boolean> {
    const res = await fetchMessages(sessionId, {
      around_ordinal: targetOrdinal,
      limit: PAGE_SIZE,
    });
    messages = res.data;
    totalMessages = res.total;
    await tick();
    scheduleActiveBucketSync();
    return res.data.length > 0;
  }

  async function ensureOrdinalLoaded(targetOrdinal: number) {
    const startOrdinal = messages[0]?.ordinal ?? null;
    const endOrdinal = messages[messages.length - 1]?.ordinal ?? null;
    if (startOrdinal != null && endOrdinal != null && targetOrdinal >= startOrdinal && targetOrdinal <= endOrdinal) {
      return;
    }
    await loadWindowAroundOrdinal(targetOrdinal);
  }

  function findLoadedOrdinal(targetOrdinal: number): number | null {
    let fallback = messages[messages.length - 1]?.ordinal ?? null;
    for (const message of messages) {
      if (message.ordinal >= targetOrdinal) return message.ordinal;
      fallback = message.ordinal;
    }
    return fallback;
  }

  async function jumpToOrdinal(targetOrdinal: number) {
    await ensureOrdinalLoaded(targetOrdinal);
    await tick();

    const resolvedOrdinal = findLoadedOrdinal(targetOrdinal);
    if (resolvedOrdinal == null || !transcriptEl) return;

    const targetEl = transcriptEl.querySelector<HTMLElement>(`[data-message-ordinal="${resolvedOrdinal}"]`);
    if (!targetEl) return;

    markHighlightedOrdinal(resolvedOrdinal);
    targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    activeBucketIndex = findBucketIndexForOrdinal(resolvedOrdinal);
    scheduleActiveBucketSync();
  }

  async function handleSelectActivityBucket(bucket: SessionActivityBucket) {
    if (bucket.start_ordinal == null) return;

    activeBucketIndex = bucket.bucket_index;
    await jumpToOrdinal(bucket.start_ordinal);
  }

  async function handlePinMessage(message: Message) {
    pinMutationOrdinal = message.ordinal;
    try {
      const pinned = await pins.pin(sessionId, message.id);
      sessionPinnedOrdinals = [...new Set([...sessionPinnedOrdinals, pinned.message_ordinal])].sort((a, b) => a - b);
    } catch (err) {
      console.error('Failed to pin message:', err);
    } finally {
      if (pinMutationOrdinal === message.ordinal) {
        pinMutationOrdinal = null;
      }
    }
  }

  async function handleUnpinMessage(message: Message) {
    pinMutationOrdinal = message.ordinal;
    try {
      await pins.unpin(sessionId, message.id);
      sessionPinnedOrdinals = sessionPinnedOrdinals.filter((ordinal) => ordinal !== message.ordinal);
    } catch (err) {
      console.error('Failed to unpin message:', err);
    } finally {
      if (pinMutationOrdinal === message.ordinal) {
        pinMutationOrdinal = null;
      }
    }
  }

  async function load() {
    loading = true;
    error = null;
    activityLoading = true;
    activityError = null;
    activity = null;
    activeBucketIndex = null;
    markHighlightedOrdinal(null);
    try {
      const [sess, msgs, kids, activityData] = await Promise.all([
        fetchBrowsingSession(sessionId),
        fetchMessages(sessionId, initialMessageOrdinal != null
          ? { around_ordinal: initialMessageOrdinal, limit: PAGE_SIZE }
          : { limit: PAGE_SIZE }),
        fetchSessionChildren(sessionId).catch(() => ({ data: [] })),
        fetchSessionActivity(sessionId).catch((err) => {
          console.error('Failed to load session activity:', err);
          activityError = 'Failed to load activity map.';
          return null;
        }),
      ]);
      session = sess;
      messages = msgs.data;
      totalMessages = msgs.total;
      children = kids.data;
      activity = activityData;
      try {
        await pins.loadSession(sessionId);
      } catch (err) {
        console.error('Failed to load session pins:', err);
      }
      sessionPinnedOrdinals = [...(pins.sessionPins[sessionId] ?? [])];
    } catch (err) {
      console.error('Failed to load session:', err);
      error = err instanceof Error && err.message.includes('(404)')
        ? `Session not found: ${sessionId}`
        : 'Failed to load session.';
    } finally {
      loading = false;
      activityLoading = false;
      await tick();
      scheduleActiveBucketSync();
      if (!error && initialMessageOrdinal != null) {
        await jumpToOrdinal(initialMessageOrdinal);
      }
    }
  }

  async function loadMore(): Promise<boolean> {
    if (loadingMore || !hasNextMessages) return false;
    loadingMore = true;
    try {
      const nextOffset = (messages[messages.length - 1]?.ordinal ?? -1) + 1;
      const res = await fetchMessages(sessionId, {
        offset: nextOffset,
        limit: PAGE_SIZE,
      });
      messages = [...messages, ...res.data];
      totalMessages = res.total;
      await tick();
      scheduleActiveBucketSync();
      return res.data.length > 0;
    } catch (err) {
      console.error('Failed to load more messages:', err);
      return false;
    } finally {
      loadingMore = false;
    }
  }

  async function loadPrevious(): Promise<boolean> {
    if (loadingPrevious || !hasPreviousMessages) return false;
    const startOrdinal = messages[0]?.ordinal ?? 0;
    const offset = Math.max(0, startOrdinal - PAGE_SIZE);
    const limit = startOrdinal - offset;
    const previousScrollHeight = transcriptEl?.scrollHeight ?? 0;
    loadingPrevious = true;
    try {
      const res = await fetchMessages(sessionId, {
        offset,
        limit,
      });
      messages = [...res.data, ...messages];
      totalMessages = res.total;
      await tick();
      if (transcriptEl) {
        transcriptEl.scrollTop += transcriptEl.scrollHeight - previousScrollHeight;
      }
      scheduleActiveBucketSync();
      return res.data.length > 0;
    } catch (err) {
      console.error('Failed to load previous messages:', err);
      return false;
    } finally {
      loadingPrevious = false;
    }
  }

  onMount(() => {
    load();
  });

  onDestroy(() => {
    clearHighlightTimer();
    if (scrollFrame != null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(scrollFrame);
    }
  });
</script>

<main class="flex-1 min-h-0 overflow-hidden flex flex-col">
  <!-- Header -->
  <div class="border-b border-gray-800 px-4 sm:px-6 py-3 flex items-center gap-3 shrink-0">
    <button
      class="text-gray-400 hover:text-gray-200 text-sm"
      onclick={onclose}
    >
      ← Back
    </button>

    {#if session}
      <div class="flex items-center gap-2 min-w-0 flex-1">
        <span
          class="inline-block w-2 h-2 rounded-full shrink-0"
          style="background-color: {agentHexColor(session.agent)}"
        ></span>
        <span class="text-sm text-gray-200 truncate font-medium">
          {displayTitle}
        </span>
      </div>
      <div class="flex items-center gap-3 text-xs text-gray-500 shrink-0">
        {#if session.project}
          <span class="bg-gray-800 px-1.5 py-0.5 rounded">{session.project}</span>
        {/if}
        {#if session.integration_mode}
          <span class="rounded border border-gray-700 px-1.5 py-0.5 uppercase tracking-wide">{session.integration_mode}</span>
        {/if}
        {#if session.fidelity}
          <span class="rounded border border-gray-700 px-1.5 py-0.5 uppercase tracking-wide">{session.fidelity} fidelity</span>
        {/if}
        <span>{session.message_count} messages</span>
        {#if session.started_at}
          <span>{timeAgo(session.started_at)}</span>
        {/if}
      </div>
    {/if}
  </div>

  {#if session}
    <div class="border-b border-gray-800 px-4 sm:px-6 py-2 space-y-2 text-xs text-gray-500">
      <div class="flex items-center gap-2 flex-wrap">
        <ProjectionCapabilities capabilities={session.capabilities} variant="summary" />
      </div>
      <ProjectionCapabilities capabilities={session.capabilities} />
    </div>
  {/if}

  <!-- Children -->
  {#if children.length > 0}
    <div class="border-b border-gray-800 px-4 sm:px-6 py-2 text-xs text-gray-500">
      <span class="mr-2">Sub-sessions:</span>
      {#each children as child}
        <span class="inline-block bg-gray-800 px-1.5 py-0.5 rounded mr-1">
          {(getSessionPreviewText(child.first_message) || (child.message_count > 0 ? 'Local command activity' : child.id.slice(0, 8))).slice(0, 30)}
        </span>
      {/each}
    </div>
  {/if}

  <!-- Messages -->
  <div class="min-h-0 flex-1 overflow-hidden px-4 sm:px-6 py-4">
    <div class="flex h-full min-h-0 flex-col gap-4 lg:flex-row lg:items-start">
      <div
        bind:this={transcriptEl}
        class="min-h-0 flex-1 overflow-y-auto"
        onscroll={handleTranscriptScroll}
      >
        <div class="space-y-4">
          {#if loading}
            <div class="text-center py-16 text-gray-500 text-sm">Loading messages...</div>
          {:else if error}
            <div class="text-center py-16 text-red-400">
              <p class="text-sm">{error}</p>
              <button class="text-xs mt-2 text-blue-400 hover:text-blue-300" onclick={() => load()}>Retry</button>
            </div>
          {:else if messages.length === 0}
            {#if session && !hasSessionCapability(session.capabilities, 'history')}
              <div class="text-center py-16 text-gray-500">
                <p class="text-sm text-gray-300">Transcript history unavailable.</p>
                <p class="mt-2 text-xs text-gray-500">
                  {session.integration_mode || session.agent} currently projects this session without transcript history.
                </p>
                <p class="mt-1 text-xs text-gray-600">
                  Search and tool analytics are limited by this session&apos;s reported capability contract.
                </p>
              </div>
            {:else}
              <div class="text-center py-16 text-gray-500 text-sm">No messages in this session.</div>
            {/if}
          {:else}
            {#if hasPreviousMessages}
              <div class="text-center py-3">
                <button
                  class="text-sm text-blue-400 hover:text-blue-300"
                  onclick={() => loadPrevious()}
                  disabled={loadingPrevious}
                >
                  {loadingPrevious ? 'Loading...' : `Load previous (${loadedStartOrdinal}/${totalMessages})`}
                </button>
              </div>
            {/if}

            {#each messages as message (message.id)}
                <MessageBlock
                  message={message}
                  highlighted={highlightedOrdinal === message.ordinal}
                  pinned={sessionPinnedOrdinals.includes(message.ordinal)}
                  pinning={pinMutationOrdinal === message.ordinal}
                onpin={() => handlePinMessage(message)}
                onunpin={() => handleUnpinMessage(message)}
              />
            {/each}

            {#if hasNextMessages}
              <div class="text-center py-3">
                <button
                  class="text-sm text-blue-400 hover:text-blue-300"
                  onclick={() => loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading...' : `Load more (${(loadedEndOrdinal ?? -1) + 1}/${totalMessages})`}
                </button>
              </div>
            {/if}
          {/if}
        </div>
      </div>

      {#if showMinimap}
        <div class="shrink-0 lg:w-24 xl:w-28">
          <ActivityMinimap
            {activity}
            loading={activityLoading}
            error={activityError}
            {activeBucketIndex}
            onselect={handleSelectActivityBucket}
          />
        </div>
      {/if}
    </div>
  </div>
</main>
