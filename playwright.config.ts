import { defineConfig } from '@playwright/test';

// End-to-end tests run the UI in Chromium against a real relay server.
// PW_CHROMIUM lets environments with a preinstalled browser skip `playwright install`.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    viewport: { width: 1360, height: 860 },
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: [
    {
      command: 'node server/src/index.ts',
      env: { PORT: '8790', DATA_DIR: 'memory' },
      url: 'http://127.0.0.1:8790/health',
      reuseExistingServer: false,
    },
    {
      command: 'npx vite --config vite.web.config.mts --port 5179 --strictPort',
      url: 'http://127.0.0.1:5179',
      reuseExistingServer: false,
    },
  ],
});
