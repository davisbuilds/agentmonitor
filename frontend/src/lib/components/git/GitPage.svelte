<script lang="ts">
  import { onMount } from 'svelte';
  import { analytics } from '../../stores/analytics.svelte';
  import GitCommits from './GitCommits.svelte';
  import GitBreakdown from './GitBreakdown.svelte';
  import GitPullRequests from './GitPullRequests.svelte';

  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  onMount(() => {
    void analytics.initializeGit();
    const timer = window.setInterval(() => {
      void analytics.fetchGitActivity();
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      analytics.dispose();
    };
  });
</script>

<main class="flex-1 overflow-y-auto p-4 sm:p-6">
  <div class="mx-auto max-w-[1600px] space-y-4">
    <GitCommits />
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
      <div class="xl:col-span-7"><GitBreakdown /></div>
      <div class="xl:col-span-5"><GitPullRequests /></div>
    </div>
  </div>
</main>
