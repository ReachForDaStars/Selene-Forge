import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 3001,
    strictPort: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 3001,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1800,
  },
});
