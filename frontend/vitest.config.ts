import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Unit-test harness for the `/app/` frontend. The Svelte plugin compiles both
// `.svelte` components and the rune-bearing `.svelte.ts` store modules, so
// module-level `$state` behaves exactly as it does in the real build. happy-dom
// provides DOM/EventSource globals for the store + (later) component layer.
// Tailwind is intentionally omitted — tests assert logic, not styles.
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
