import { defineConfig, devices } from '@playwright/test';

// The iPhone app (mobile/) in its web build, at iPhone size, against a real relay. Native parts
// (Keychain, Face ID, SQLite) have web stand-ins here; they are checked on the device builds.
export default defineConfig({
  testDir: 'tests/e2e-mobile',
  timeout: 120_000,
  workers: 1,
  use: {
    ...devices['iPhone 15'],
    colorScheme: 'dark',
    defaultBrowserType: 'chromium',
    baseURL: 'http://127.0.0.1:5181',
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: [
    {
      command: 'node server/src/index.ts',
      env: { PORT: '8791', DATA_DIR: 'memory', REGISTRATIONS_PER_HOUR: '500' },
      url: 'http://127.0.0.1:8791/health',
      reuseExistingServer: false,
    },
    {
      command: 'cd mobile && npx expo export --platform web --output-dir dist-web && node ../tests/e2e-mobile/serve.mjs',
      url: 'http://127.0.0.1:5181',
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
