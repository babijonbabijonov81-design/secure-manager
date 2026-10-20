import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Strict Content-Security-Policy for production builds (dev needs inline HMR scripts). */
export const cspPlugin = (): Plugin => ({
  name: 'veil-csp',
  apply: 'build',
  transformIndexHtml: (html: string) =>
    html.replace('<!-- CSP is injected at build time (see electron.vite.config.mts) -->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

export default defineConfig({
  main: {
    build: {
      // noble is ESM-only: bundle it into the CommonJS main process instead of requiring it.
      externalizeDeps: { exclude: ['@noble/curves', '@noble/hashes', '@noble/ciphers'] },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: 'src/preload/index.ts', card: 'src/preload/card.ts' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), cspPlugin()],
    build: {
      rollupOptions: {
        // The main window and the notification cards.
        input: { index: 'src/renderer/index.html', card: 'src/renderer/card.html' },
      },
    },
  },
});
