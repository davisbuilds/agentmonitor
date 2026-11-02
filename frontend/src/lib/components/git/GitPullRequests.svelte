<script lang="ts">
  import { InfoTip } from '../ui';
  import { analytics } from '../../stores/analytics.svelte';
  import { agentHexColor, timeAgo } from '../../format';
  import { sessionTitle } from '../../session-text';

  const data = $derived(analytics.gitActivity);
</script>

<section class="rounded-lg border border-line bg-surface p-4" aria-labelledby="git-pull-requests-heading">
  <div class="mb-3 flex items-center gap-1.5">
    <h3 id="git-pull-requests-heading" class="text-h3">Latest Pull Requests</h3>
    <InfoTip label="Latest Pull Requests">
      <p>Pull requests sessions opened in the range, newest first, found from the links <code>gh pr create</code> printed. Select one's session to open it, or its number to open it on GitHub.</p>
    </InfoTip>
  </div>

  {#if analytics.loading.git && !data}
    <div class="py-12 text-center text-meta text-text-muted">Loading pull requests…</div>
  {:else if analytics.errors.git}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.git}</div>
  {:else if !data || data.pull_requests.length === 0}
    <div class="py-12 text-center text-meta text-text-muted">No pull requests opened in the selected range.</div>
  {:else}
    <ul class="space-y-2.5" aria-label="Latest pull requests sessions opened">
      {#each data.pull_requests as pr (pr.url)}
        <li data-testid="git-pull-request">
          <div class="flex items-baseline justify-between gap-3 text-meta">
            <button class="flex min-w-0 items-center gap-2 text-left text-text hover:text-accent focus-visible:text-accent"
              onclick={() => analytics.openSession(pr.session_id)}>
              <span class="h-2 w-2 shrink-0 rounded-full" style={`background:${agentHexColor(pr.agent)}`} aria-hidden="true"></span>
              <span class="truncate">{sessionTitle(pr)}</span>
            </button>
            <span class="shrink-0 tabular font-mono text-text-faint">{timeAgo(pr.opened_at)}</span>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-2 pl-4 text-meta text-text-muted">
            <a class="tabular font-mono hover:text-accent focus-visible:text-accent" href={pr.url} target="_blank" rel="noopener noreferrer">{pr.repo}#{pr.number}</a>
            <span class="rounded-sm border border-line px-1.5 py-0.5">{pr.merged ? 'Merged' : 'Not merged'}</span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
