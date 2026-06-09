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
  import { timeAgo, agentHexColor, agentDisplayName } from '../../format';
  import { getMessagePreviewText, getSessionPreviewText } from '../../session-text';
  import { classifyMessageAuthor, type MessageAuthor } from '../../session-roles';
  import ProjectionCapabilities from '../shared/ProjectionCapabilities.svelte';
  import { hasSessionCapability } from '../../session-capabilities';
  import { pins } from '../../stores/pins.svelte';
  import ActivityMinimap from './ActivityMinimap.svelte';
  import MessageBlock from './MessageBlock.svelte';
  import { Badge, Button, EmptyState, Select } from '../ui';
  import TraceDrillInLink from '../trace-quality/TraceDrillInLink.svelte';

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

  // Author filter operates on the loaded window only — paging pulls more, which
  // then re-filters. "all" shows everything.
  let authorFilter = $state<'all' | MessageAuthor>('all');
  const authorOptions = $derived([
    { value: 'all', label: 'All turns' },
    { value: 'you', label: 'You' },
    { value: 'assistant', label: agentDisplayName(session?.agent ?? 'unknown') },
    { value: 'tool', label: 'Tools' },
  ]);
  const filteredMessages = $derived(
    authorFilter === 'all'
      ? messages
      : messages.filter((message) => classifyMessageAuthor(message) === authorFilter),
  );

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

  // Resolve against the rendered (filtered) set so the result always has a DOM
  // node. With an author filter active, a bucket jump lands on the nearest
  // visible turn instead of silently no-opping on a hidden ordinal. When the
  // filter is "all", filteredMessages === messages, so behavior is unchanged.
  function findLoadedOrdinal(targetOrdinal: number): number | null {
    let fallback: number | null = null;
    for (const message of filteredMessages) {
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
  <div class="border-b border-line px-4 sm:px-6 py-3 flex items-center gap-3 shrink-0">
    <Button variant="ghost" size="sm" onclick={onclose}>← Back</Button>

    {#if session}
      <div class="flex items-center gap-2 min-w-0 flex-1">
        <span
          class="inline-block w-2 h-2 rounded-full shrink-0"
          style="background-color: {agentHexColor(session.agent)}"
        ></span>
        <span class="truncate text-body font-medium text-text">
          {displayTitle}
        </span>
      </div>
      <div class="flex items-center gap-2 text-meta text-text-faint shrink-0">
        <TraceDrillInLink sessionId={sessionId} label="Quality ↗" />
        {#if session.project}
          <Badge tone="neutral">{session.project}</Badge>
        {/if}
        {#if session.integration_mode}
          <Badge tone="neutral" class="uppercase tracking-wide">{session.integration_mode}</Badge>
        {/if}
        {#if session.fidelity}
          <Badge tone="neutral" class="uppercase tracking-wide">{session.fidelity} fidelity</Badge>
        {/if}
        <span class="tabular font-mono">{session.message_count} messages</span>
        {#if session.started_at}
          <span class="tabular font-mono">{timeAgo(session.started_at)}</span>
        {/if}
      </div>
    {/if}
  </div>

  {#if session}
    <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 sm:px-6 py-2">
      <ProjectionCapabilities capabilities={session.capabilities} variant="summary" />
      <ProjectionCapabilities capabilities={session.capabilities} />
      <div class="ml-auto flex items-center gap-2">
        {#if authorFilter !== 'all'}
          <span class="tabular font-mono text-meta text-text-faint">
            {filteredMessages.length} of {messages.length} loaded
          </span>
        {/if}
        <Select
          value={authorFilter}
          options={authorOptions}
          aria-label="Filter transcript by author"
          onchange={(value) => (authorFilter = value as 'all' | MessageAuthor)}
        />
      </div>
    </div>
  {/if}

  <!-- Children -->
  {#if children.length > 0}
    <div class="border-b border-line px-4 sm:px-6 py-2 flex flex-wrap items-center gap-1.5 text-meta text-text-faint">
      <span class="mr-1">Sub-sessions:</span>
      {#each children as child}
        <Badge tone="neutral">
          {(getSessionPreviewText(child.first_message) || (child.message_count > 0 ? 'Local command activity' : child.id.slice(0, 8))).slice(0, 30)}
        </Badge>
      {/each}
    </div>
  {/if}

  <!-- Messages -->
  <div class="min-h-0 flex-1 overflow-hidden px-4 sm:px-6 py-4">
    <div class="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      <div
        bind:this={transcriptEl}
        class="min-h-0 flex-1 overflow-y-auto"
        onscroll={handleTranscriptScroll}
      >
        <div class="space-y-4">
          {#if loading}
            <div class="text-center py-16 text-meta text-text-muted">Loading messages…</div>
          {:else if error}
            <EmptyState title={error}>
              {#snippet action()}
                <Button variant="neutral" size="sm" onclick={() => load()}>Retry</Button>
              {/snippet}
            </EmptyState>
          {:else if messages.length === 0}
            {#if session && !hasSessionCapability(session.capabilities, 'history')}
              <EmptyState
                title="Transcript history unavailable."
                description="{session.integration_mode || session.agent} currently projects this session without transcript history. Search and tool analytics are limited by this session's reported capability contract."
              />
            {:else}
              <EmptyState title="No messages in this session." />
            {/if}
          {:else}
            {#if hasPreviousMessages}
              <div class="text-center py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => loadPrevious()}
                  disabled={loadingPrevious}
                >
                  {loadingPrevious ? 'Loading…' : `Load previous (${loadedStartOrdinal}/${totalMessages})`}
                </Button>
              </div>
            {/if}

            {#if filteredMessages.length === 0}
              <div class="py-8 text-center text-meta text-text-muted">
                No {authorFilter === 'you' ? 'You' : authorFilter === 'tool' ? 'Tool' : agentDisplayName(session?.agent ?? 'unknown')}
                turns in the loaded window — load more to keep looking.
              </div>
            {/if}

            {#each filteredMessages as message (message.id)}
                <MessageBlock
                  message={message}
                  agent={session?.agent ?? 'unknown'}
                  highlighted={highlightedOrdinal === message.ordinal}
                  pinned={sessionPinnedOrdinals.includes(message.ordinal)}
                  pinning={pinMutationOrdinal === message.ordinal}
                onpin={() => handlePinMessage(message)}
                onunpin={() => handleUnpinMessage(message)}
              />
            {/each}

            {#if hasNextMessages}
              <div class="text-center py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading…' : `Load more (${(loadedEndOrdinal ?? -1) + 1}/${totalMessages})`}
                </Button>
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
