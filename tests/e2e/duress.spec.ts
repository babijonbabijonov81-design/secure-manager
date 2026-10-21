import { expect, test } from '@playwright/test';
import { register, shot } from './helpers.ts';

const suffix = Date.now().toString(36).slice(-5);

test('Settings → Безопасность: protection score and the duress password', async ({ browser }) => {
  test.setTimeout(150_000);
  const { page } = await register(browser, 'du', 'Алиса', suffix);
  await page.locator('.rail').getByRole('button', { name: 'Избранное' }).click();
  const input = page.getByLabel('Заметка, пароль или ссылка — для себя');
  await input.fill('Настоящая заметка');
  await input.press('Enter');

  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Безопасность' }).click();
  await expect(page.getByTestId('protection-bar')).toContainText('Защита: 3 из 5');
  const duress = page.getByTestId('duress');
  await duress.locator('summary').click();
  await expect(duress).toContainText('Экспертиза диска');
  await duress.getByRole('switch', { name: 'Аварийный пароль' }).click();
  await page.getByRole('textbox', { name: 'Аварийный пароль', exact: true }).fill('Very-Secret-42');
  await page.getByLabel('Повторите аварийный пароль').fill('Very-Secret-42');
  await page.getByRole('button', { name: 'Включить', exact: true }).click();
  await expect(page.getByText('Аварийный пароль должен отличаться от настоящего')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('textbox', { name: 'Аварийный пароль', exact: true }).fill('Panic-Button-77');
  await page.getByLabel('Повторите аварийный пароль').fill('Panic-Button-77');
  await page.getByRole('button', { name: 'Включить', exact: true }).click();
  await expect(duress.locator('.chip')).toHaveText('Включён', { timeout: 20_000 });
  await shot(page, '42-security');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).first().click();

  // Under duress: the same lock screen, the same name, nothing inside.
  await page.locator('.rail').getByRole('button', { name: 'Заблокировать' }).click();
  await page.getByLabel('Пароль', { exact: true }).fill('Panic-Button-77');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await expect(page.getByText('Добро пожаловать')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.welcome-pane')).toContainText('Алиса');
  await expect(page.locator('.chat-item')).toHaveCount(1);
  await expect(page.locator('.status-pill, .banner.warn')).toHaveCount(0);
  await page.locator('.rail').getByRole('button', { name: 'Избранное' }).click();
  await expect(page.getByText('Здесь пока пусто')).toBeVisible();
  await page.getByRole('button', { name: 'Новый чат' }).first().click();
  await page.getByLabel('Имя пользователя').fill('somebody_else');
  await page.getByRole('button', { name: 'Найти и открыть чат' }).click();
  await expect(page.getByText('Пользователь @somebody_else не найден')).toBeVisible();
  await page.keyboard.press('Escape');

  // The real password: everything is still there.
  await page.locator('.rail').getByRole('button', { name: 'Заблокировать' }).click();
  await page.getByLabel('Пароль', { exact: true }).fill('Very-Secret-42');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await page.locator('.rail').getByRole('button', { name: 'Избранное' }).click();
  await expect(page.getByTestId('vault-card')).toContainText('Настоящая заметка');
});
