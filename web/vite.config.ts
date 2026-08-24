import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Built to a `dist` at the repository root rather than `web/dist`.
  //
  // Vercel looks for an output directory relative to the project root, and its
  // default name is `dist`. Emitting there means the deployment works on the
  // default settings as well as on the explicit `outputDirectory` in
  // vercel.json, instead of depending on which of the two wins.
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
});
