import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
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
