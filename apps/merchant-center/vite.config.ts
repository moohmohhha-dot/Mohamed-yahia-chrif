import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API (ARUMA CORE) runs on :3000; the dev server forwards /v1 to it,
// so the browser sees a single origin (no CORS, no cross-site cookies).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/v1': process.env.ARUMA_API_URL ?? 'http://localhost:3000' },
  },
  preview: {
    port: 4173,
    proxy: { '/v1': process.env.ARUMA_API_URL ?? 'http://localhost:3000' },
  },
});
