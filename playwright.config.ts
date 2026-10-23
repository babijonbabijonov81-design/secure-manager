import { defineConfig } from '@playwright/test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The test relay "sends" email by appending to this file (shared by runner and workers). */
export const MAIL_FILE = join(tmpdir(), 'veil-e2e-mail.jsonl');
process.env.VEIL_E2E_MAIL = MAIL_FILE;
if (!process.env.TEST_WORKER_INDEX) rmSync(MAIL_FILE, { force: true });

// End-to-end tests run the UI in Chromium against a real relay server.
// PW_CHROMIUM lets environments with a preinstalled browser skip `playwright install`.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    viewport: { width: 1360, height: 860 },
    launchOptions: {
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
      // A fake microphone for voice messages.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: [
    {
      command: 'node server/src/index.ts',
      // Every spec registers new accounts from 127.0.0.1. Recovery by email alone does not wait here
      // (the 7-day hold is covered by tests/features.test.ts).
      env: { PORT: '8790', DATA_DIR: 'memory', MAIL_LOG: MAIL_FILE, REGISTRATIONS_PER_HOUR: '500', RECOVERY_DELAY_HOURS: '0' },
      url: 'http://127.0.0.1:8790/health',
      reuseExistingServer: false,
    },
    {
      // Bind explicitly: "localhost" may resolve to IPv6 only on CI runners.
      command: 'npx vite --config vite.web.config.mts --host 127.0.0.1 --port 5179 --strictPort',
      url: 'http://127.0.0.1:5179',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
