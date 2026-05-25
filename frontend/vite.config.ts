import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Tailwind is compiled by Vite (scanning .svelte/.ts/.html) rather than the
  // backend `css:build` output. This styles the dev server at :5173 — the old
  // `/css/output.css` link was rewritten to `/app/css/output.css` by `base`
  // and missed the proxy, leaving dev unstyled. Legacy `/` keeps its own build.
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
