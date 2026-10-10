import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The Admin Panel talks to ARUMA CORE (:3000 in development) through /v1, on the same origin.
/**
 * Content-Security-Policy for the built app: only its own scripts run, it only talks to its own origin
 * (the API is served under /v1 on the same domain), images may be local or generated (QR codes).
 * Inline styles are allowed for React's style attributes. The web server adds frame-ancestors 'none'
 * and HSTS (docs/SECURITY.md); a meta tag cannot set those.
 */
const csp = (): Plugin => ({
  name: 'aruma-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" />\n    <meta name="referrer" content="no-referrer" />`,
    ),
});

export default defineConfig({
  plugins: [react(), csp()],
  server: {
    port: 5174,
    proxy: { '/v1': process.env.ARUMA_API_URL ?? 'http://localhost:3000' },
  },
  preview: {
    port: 4174,
    proxy: { '/v1': process.env.ARUMA_API_URL ?? 'http://localhost:3000' },
  },
});
