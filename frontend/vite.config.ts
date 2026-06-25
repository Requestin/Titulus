import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Backend the dev server proxies to (DEVELOPMENT_PROMPT §8.5). Override with
// VITE_BACKEND=http://host:port for non-default deployments.
const BACKEND = process.env.VITE_BACKEND || 'http://localhost:3001';
const WS_BACKEND = BACKEND.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
      // Shared render logic — the editor imports the SAME runtime as air (WYSIWYG).
      '@runtime': resolve(here, '../runtime/src/index.ts'),
    },
  },
  server: {
    port: 3000,
    // nginx forwards the public Host header; allow our dev domain.
    allowedHosts: ['graphics.gyhyry.com', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': BACKEND,
      '/uploads': BACKEND,
      '/fonts': BACKEND,
      '/channel.html': BACKEND,
      '/bg-runtime.js': BACKEND,
      '/ws': { target: WS_BACKEND, ws: true },
    },
  },
});
