import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * MB Parfum storefront. Two builds:
 * - normal: talks to ARUMA CORE under /v1 on the same domain (the dev server forwards /v1 to :3000);
 * - demo (`--mode demo`): no server at all, a sample catalog runs in the browser (src/demo), so the shop
 *   can be shown anywhere as static files. The demo never talks to the network.
 *
 * Content-Security-Policy of the normal build: only its own scripts, its own API, Google Fonts.
 */
const csp = (): Plugin => ({
  name: 'aruma-csp',
  apply: 'build',
  transformIndexHtml: (html, ctx) =>
    ctx.server
      ? html
      : html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'none'; form-action 'self'" />\n    <meta name="referrer" content="no-referrer" />`,
        ),
});

export default defineConfig(({ mode }) => ({
  // The demo is opened from any folder or host: relative asset paths.
  base: mode === 'demo' ? './' : '/',
  plugins: [react(), ...(mode === 'demo' ? [] : [csp()])],
  define: { __DEMO__: JSON.stringify(mode === 'demo') },
  build: { outDir: mode === 'demo' ? 'dist-demo' : 'dist' },
  server: { port: 5175, proxy: { '/v1': process.env.ARUMA_API_URL ?? 'http://localhost:3000' } },
  preview: { port: 4175, proxy: { '/v1': process.env.ARUMA_API_URL ?? 'http://localhost:3000' } },
}));
