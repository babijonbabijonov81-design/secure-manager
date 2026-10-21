import { expect, test } from '@playwright/test';
import { openChat, register, send, shot } from './helpers.ts';

// «Поиск по всей переписке»: messages from every chat, filters, and a jump to the message.
test('search across all chats on this device', async ({ browser }) => {
  const suffix = Date.now().toString(36);
  const alice = await register(browser, 'srchalice', 'Алиса', suffix);
  const bob = await register(browser, 'srchbob', 'Борис', suffix);
  const page = alice.page;

  await openChat(page, bob.username);
  await send(page, 'Ключи от дачи под ёлкой у крыльца');
  for (let i = 0; i < 25; i++) await send(page, `Сообщение для прокрутки №${i + 1}`);
  await send(page, 'Почитай https://example.org/garden');
  await expect(page.locator('section .text').getByText('Почитай https://example.org/garden')).toBeVisible();

  const search = page.getByLabel('Поиск чатов');
  await expect(search).toHaveAttribute('placeholder', 'Поиск — только по этому устройству');
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await search.fill('елкой ключи');
  const hit = page.getByTestId('search-hit');
  await expect(hit).toHaveCount(1);
  await expect(hit.locator('mark')).toHaveText(['Ключи', 'ёлкой']);
  await shot(page, 'search');

  await hit.click();
  const bubble = page.locator('.msg-row.highlight');
  await expect(bubble).toContainText('Ключи от дачи под ёлкой');
  await expect(bubble).toBeInViewport();

  await search.fill('');
  await search.fill('по');
  await page.getByRole('button', { name: 'Ссылки', exact: true }).click();
  await expect(page.getByTestId('search-hit')).toHaveCount(1);
  await expect(page.getByTestId('search-hit')).toContainText('example.org/garden');
  await page.getByRole('button', { name: 'Голосовые', exact: true }).click();
  await expect(page.getByText('Ничего не найдено на этом устройстве')).toBeVisible();
  await search.press('Escape');
  await expect(page.getByTestId('search-hit')).toHaveCount(0);
});
