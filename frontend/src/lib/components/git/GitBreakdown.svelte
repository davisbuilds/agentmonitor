<script lang="ts">
  import { InfoTip } from '../ui';
  import { analytics } from '../../stores/analytics.svelte';
  import { agentHexColor, agentName, formatNumber } from '../../format';

  const data = $derived(analytics.gitActivity);
  const PROJECT_ROWS = 12;
</script>

<section class="rounded-lg border border-line bg-surface p-4" aria-labelledby="git-breakdown-heading">
  <div class="mb-3 flex items-center gap-1.5">
    <h3 id="git-breakdown-heading" class="text-h3">By Agent and Project</h3>
    <InfoTip label="By Agent and Project">
      <p>Each agent's proven commits, the sessions they came from, and the pull requests its sessions opened. A pull request is merged when GitHub says so, or when local git has its merge commit. Projects list every commit in their repository, split by who made it. Select a project to narrow the page to it.</p>
    </InfoTip>
  </div>

  {#if analytics.loading.git && !data}
    <div class="py-12 text-center text-meta text-text-muted">Loading…</div>
  {:else if analytics.errors.git}
    <div class="py-12 text-center text-meta text-danger">{analytics.errors.git}</div>
  {:else if !data || (data.agents.length === 0 && data.projects.length === 0)}
    <div class="py-12 text-center text-meta text-text-muted">No git activity in the selected range.</div>
  {:else}
    {#if data.agents.length > 0}
      <table class="w-full text-meta">
        <caption class="sr-only">Commits and pull requests by agent</caption>
        <thead class="text-left text-text-faint">
          <tr>
            <th scope="col" class="pb-1.5 font-normal">Agent</th>
            <th scope="col" class="pb-1.5 pl-3 text-right font-normal">Commits</th>
            <th scope="col" class="pb-1.5 pl-3 text-right font-normal">Sessions</th>
            <th scope="col" class="pb-1.5 pl-3 text-right font-normal">PRs</th>
            <th scope="col" class="pb-1.5 pl-3 text-right font-normal">Merged</th>
          </tr>
        </thead>
        <tbody>
          {#each data.agents as row (row.agent)}
            <tr class="border-t border-line">
              <th scope="row" class="py-1.5 text-left font-normal text-text">
                <span class="flex items-center gap-2">
                  <span class="h-2 w-2 shrink-0 rounded-full" style={`background:${agentHexColor(row.agent)}`} aria-hidden="true"></span>
                  {agentName(row.agent)}
                </span>
              </th>
              <td class="py-1.5 pl-3 text-right tabular font-mono text-text">{formatNumber(row.commits)}</td>
              <td class="py-1.5 pl-3 text-right tabular font-mono text-text-muted">{formatNumber(row.sessions)}</td>
              <td class="py-1.5 pl-3 text-right tabular font-mono text-text">{formatNumber(row.prs_opened)}</td>
              <td class="py-1.5 pl-3 text-right tabular font-mono text-text-muted">{formatNumber(row.prs_merged)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    {#if data.projects.length > 0}
      <table class="mt-4 w-full text-meta">
        <caption class="sr-only">Commits by project</caption>
        <thead class="text-left text-text-faint">
          <tr>
            <th scope="col" class="pb-1.5 font-normal">Project</th>
            <th scope="col" class="pb-1.5 pl-3 text-right font-normal">By agents</th>
            <th scope="col" class="pb-1.5 pl-3 text-right font-normal">Outside</th>
            <th scope="col" class="pb-1.5 pl-3 text-right font-normal">Commits</th>
          </tr>
        </thead>
        <tbody>
          {#each data.projects.slice(0, PROJECT_ROWS) as row (row.project)}
            {@const byAgents = Object.values(row.by_agent).reduce((sum, value) => sum + value, 0)}
            <tr class="border-t border-line">
              <th scope="row" class="py-1.5 text-left font-normal">
                <button class="truncate text-left text-text hover:text-accent focus-visible:text-accent"
                  onclick={() => analytics.drillDownToProject(row.project)}>{row.project}</button>
              </th>
              <td class="py-1.5 pl-3 text-right tabular font-mono text-text">{formatNumber(byAgents)}</td>
              <td class="py-1.5 pl-3 text-right tabular font-mono text-text-muted">{formatNumber(row.outside)}</td>
              <td class="py-1.5 pl-3 text-right tabular font-mono text-text-muted">{formatNumber(row.commits)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if data.projects.length > PROJECT_ROWS}
        <p class="mt-2 text-meta text-text-faint">{formatNumber(data.projects.length - PROJECT_ROWS)} more project{data.projects.length - PROJECT_ROWS === 1 ? '' : 's'} with fewer commits.</p>
      {/if}
    {/if}
  {/if}
</section>
