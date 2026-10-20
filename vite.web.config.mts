// Runs the UI in a regular browser (development and end-to-end tests).
// Use ?profile=<name> in the URL to keep several independent accounts side by side.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { cspPlugin } from './electron.vite.config.mts';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), cspPlugin()],
  server: { port: 5173, strictPort: true },
  build: { outDir: '../../out/web', emptyOutDir: true },
});
