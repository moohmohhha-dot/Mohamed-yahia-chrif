import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Admin Panel talks to ARUMA CORE (:3000 in development) through /v1, on the same origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/v1': process.env.ARUMA_API_URL ?? 'http://localhost:3000' },
  },
  preview: {
    port: 4174,
    proxy: { '/v1': process.env.ARUMA_API_URL ?? 'http://localhost:3000' },
  },
});
