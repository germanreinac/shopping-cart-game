import { defineConfig } from 'vite';

// Relative base so the build works from any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  // Stamped into the page so it is obvious which build a browser is actually showing.
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(5, 16).replace('T', ' ')) },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
