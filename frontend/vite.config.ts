import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Tailwind is compiled by Vite (scanning .svelte/.ts/.html). This styles both
  // the dev server at :5173 and the built app at /app/.
  plugins: [tailwindcss(), svelte()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3141',
    },
  },
  base: '/app/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
