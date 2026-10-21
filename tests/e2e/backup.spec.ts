import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { APP, register } from './helpers.ts';

const suffix = Date.now().toString(36).slice(-5);

test('«.veil» backup: save on one computer, restore on another', async ({ browser }) => {
  test.setTimeout(150_000);
  const { page } = await register(browser, 'ka', 'Алиса', suffix);
  await page.locator('.rail').getByRole('button', { name: 'Избранное' }).click();
  const input = page.getByLabel('Заметка, пароль или ссылка — для себя');
  await input.fill('Заметка для копии');
  await input.press('Enter');

  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Безопасность' }).click();
  await page.getByTestId('backup-file').getByRole('button', { name: 'Сохранить копию' }).click();
  await page.getByLabel('Пароль копии', { exact: true }).fill('Backup-Pass-123');
  await page.getByLabel('Повторите пароль копии').fill('Backup-Pass-123');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Зашифровать и сохранить' }).click();
  const file = await (await download).path();
  expect((await (await download).suggestedFilename())).toMatch(/^veil-ka_.*\.veil$/);
  await expect(page.getByTestId('backup-file')).toContainText('Последняя копия');
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).toString()).toBe('VEILBAK1');
  expect(bytes.includes(Buffer.from('Заметка для копии'))).toBe(false);

  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto(`${APP}/?profile=kn-${suffix}`);
  await fresh.getByRole('button', { name: 'Восстановить из файла .veil' }).click();
  await fresh.getByLabel('Файл резервной копии').setInputFiles({ name: 'backup.veil', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(fresh.getByText('backup.veil')).toBeVisible();
  await fresh.getByLabel('Пароль копии').fill('wrong-password');
  await fresh.getByLabel('Новый пароль Veil', { exact: true }).fill('Another-Pass-77');
  await fresh.getByLabel('Повторите новый пароль Veil').fill('Another-Pass-77');
  await fresh.getByRole('button', { name: 'Восстановить' }).click();
  await expect(fresh.getByText('Неверный пароль копии или файл повреждён')).toBeVisible({ timeout: 30_000 });
  await fresh.getByLabel('Пароль копии').fill('Backup-Pass-123');
  await fresh.getByRole('button', { name: 'Восстановить' }).click();
  await expect(fresh.getByText('Добро пожаловать')).toBeVisible({ timeout: 30_000 });
  await fresh.locator('.rail').getByRole('button', { name: 'Избранное' }).click();
  await expect(fresh.getByTestId('vault-card')).toContainText('Заметка для копии');
});
