import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base relativo: o build funciona em qualquer host estático (Vercel, Netlify, GitHub Pages em subpasta).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: true },
  // MapLibre sozinho tem ~1 MB minificado; o resto do jogo é pequeno.
  build: { chunkSizeWarningLimit: 1600 },
});
