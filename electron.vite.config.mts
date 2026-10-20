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
      externalizeDeps: true,
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), cspPlugin()],
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html',
      },
    },
  },
});
