// Launches the built desktop app, creates an account against the embedded relay and
// takes a screenshot. Run after `npm run build` (on Linux CI: under xvfb-run).
//   node tests/electron/smoke.mjs [screenshot.png]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';

const home = mkdtempSync(join(tmpdir(), 'veil-smoke-'));
const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  env: { ...process.env, VEIL_PROFILE: `smoke${process.pid}`, HOME: home, XDG_CONFIG_HOME: home, APPDATA: home },
});
try {
  const page = await app.firstWindow();
  await page.getByText('Мессенджер, в котором ваши слова').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByRole('switch', { name: 'Свой сервер' }).click();
  await page.locator('.addresses code').first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.getByLabel('Имя', { exact: true }).fill('Smoke Test');
  await page.getByLabel('Имя пользователя').fill('smoke_test');
  await page.getByLabel('Пароль для входа').fill('Smoke-Test-123');
  await page.getByLabel('Повторите пароль').fill('Smoke-Test-123');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByText('Добро пожаловать').waitFor({ timeout: 60_000 });
  await page.getByText('В сети').waitFor({ timeout: 15_000 });
  const bridge = await page.evaluate(() => ({ platform: window.veil?.platform, version: window.veil?.version }));
  console.log('desktop bridge:', JSON.stringify(bridge));
  if (process.argv[2]) {
    await page.waitForTimeout(800);
    await page.screenshot({ path: process.argv[2] });
  }
  console.log('smoke test passed');
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
