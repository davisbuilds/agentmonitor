import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// WHY: Compile the stores with Svelte so runes execute the way they do in the app. The unit harness
// needs DOM globals but does not need stylesheet compilation.
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
