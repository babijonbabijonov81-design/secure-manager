import { expect, test } from '@playwright/test';
import { register, shot } from './helpers.ts';

// Settings → «Имя пользователя»: a live check while typing, then the change.
test('change the username in settings', async ({ browser }) => {
  const suffix = Date.now().toString(36);
  const alice = await register(browser, 'unalice', 'Алиса', suffix);
  const bob = await register(browser, 'unbob', 'Борис', suffix);
  const page = alice.page;
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Имя пользователя' }).click();
  const tab = page.getByTestId('username-tab');
  await expect(tab).toContainText(`@${alice.username}`);
  const input = tab.getByLabel('Новое имя пользователя');
  await input.fill(bob.username);
  await expect(tab.getByRole('status')).toContainText('Уже занято');
  await expect(tab.getByRole('button', { name: 'Сменить имя' })).toBeDisabled();
  await input.fill('a!');
  await expect(tab.getByRole('status')).toContainText('От 3 до 32 символов');
  const wanted = `alisa_${suffix}`;
  await input.fill(wanted);
  await expect(tab.getByRole('status')).toContainText('Свободно');
  await shot(page, 'username');
  await tab.getByRole('button', { name: 'Сменить имя' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Сменить', exact: true }).click();
  await expect(page.getByText(`Теперь вы @${wanted}`)).toBeVisible();
  await expect(tab.locator('.username-card')).toContainText(`@${wanted}`);
});
