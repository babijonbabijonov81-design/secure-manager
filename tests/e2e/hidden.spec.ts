import { expect, test } from '@playwright/test';
import { bubble, openChat, register, send } from './helpers.ts';

const suffix = Date.now().toString(36).slice(-5);

test('hidden chats: out of the list, opened with the secret phrase and a PIN', async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await register(browser, 'ha', 'Алиса', suffix);
  const bob = await register(browser, 'hb', 'Борис', suffix);
  await openChat(alice.page, bob.username);
  await send(alice.page, 'Это личное');
  await bob.page.getByTestId(`chat-${alice.username}`).click();
  await expect(bubble(bob.page, 'Это личное')).toBeVisible();
  const page = alice.page;

  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Конфиденциальность' }).click();
  await page.getByTestId('hidden-chats').getByRole('button', { name: 'Настроить скрытые чаты' }).click();
  await page.getByLabel('Секретная фраза').fill('синий кит');
  await page.getByRole('textbox', { name: 'PIN скрытых чатов', exact: true }).fill('2468');
  await page.getByLabel('Повторите PIN скрытых чатов').fill('2468');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('hidden-chats')).toContainText('Сменить фразу и PIN');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).first().click();

  await page.getByRole('button', { name: 'Скрыть чат' }).click();
  const item = page.getByTestId(`chat-${bob.username}`);
  await expect(item).toHaveCount(0);
  await send(bob.page, 'Ты тут?');
  await page.waitForTimeout(800);
  await expect(item).toHaveCount(0);
  // Searching by name finds nothing; the secret phrase opens hidden chats after the PIN.
  const search = page.getByLabel('Поиск чатов');
  await search.fill('Борис');
  await expect(page.locator('.chat-item')).toHaveCount(0);
  await search.fill('синий кит');
  await search.press('Enter');
  await page.getByRole('textbox', { name: 'PIN скрытых чатов' }).fill('1111');
  await page.getByRole('button', { name: 'Открыть' }).click();
  await expect(page.getByText('Неверный PIN. Осталось попыток: 4')).toBeVisible();
  await page.getByRole('textbox', { name: 'PIN скрытых чатов' }).fill('2468');
  await page.getByRole('button', { name: 'Открыть' }).click();
  await expect(page.getByText('Скрытые чаты открыты')).toBeVisible();
  await item.click();
  await expect(bubble(page, 'Ты тут?')).toBeVisible();
  await page.getByRole('button', { name: 'Спрятать' }).click();
  await expect(item).toHaveCount(0);
});
