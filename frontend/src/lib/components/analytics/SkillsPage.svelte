<script lang="ts">
  import { onMount } from 'svelte';
  import { analytics } from '../../stores/analytics.svelte';
  import ActiveFilters from './ActiveFilters.svelte';
  import SkillConsultationExplorer from './SkillConsultationExplorer.svelte';

  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  onMount(() => {
    void analytics.initializeSkillConsultations();
    const timer = window.setInterval(() => {
      void analytics.fetchSkillConsultations();
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      analytics.dispose();
    };
  });
</script>

<main class="flex-1 overflow-y-auto p-4 sm:p-6">
  <div class="mx-auto max-w-[1600px] space-y-4">
    <ActiveFilters />
    <SkillConsultationExplorer />
  </div>
</main>
