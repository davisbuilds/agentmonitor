<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { buildSessionsHash, parseSessionsHash, type SessionsRouteState, type SessionsView } from '../../route-state';
  import { SubTabs } from '../ui';
  import SessionsPage from './SessionsPage.svelte';
  import PinnedPage from '../pinned/PinnedPage.svelte';

  const fallback: SessionsRouteState = {
    view: 'browse',
    project: '',
    agent: '',
    sessionId: null,
    messageOrdinal: null,
  };

  let view = $state<SessionsView>('browse');

  const views: Array<{ id: SessionsView; label: string }> = [
    { id: 'browse', label: 'Browse' },
    { id: 'pinned', label: 'Pinned' },
  ];

  function syncFromHash(): void {
    if (typeof window === 'undefined') return;
    view = parseSessionsHash(window.location.hash, fallback).view;
  }

  function setView(next: SessionsView): void {
    if (next === view || typeof window === 'undefined') return;
    // Browse resets to the session list; the hashchange updates `view`.
    window.location.hash = buildSessionsHash({ ...fallback, view: next });
  }

  onMount(() => {
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', syncFromHash);
  });
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="shrink-0 border-b border-line px-4 sm:px-6 py-2">
    <SubTabs tabs={views} active={view} onchange={(id) => setView(id as SessionsView)} />
  </div>

  {#if view === 'pinned'}
    <PinnedPage />
  {:else}
    <SessionsPage />
  {/if}
</div>
