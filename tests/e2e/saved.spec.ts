import { expect, test } from '@playwright/test';
import { acceptRequest, openChat, register, send, shot } from './helpers.ts';

const suffix = Date.now().toString(36).slice(-5);

test('«Избранное»: notes, passwords with clipboard clearing, links, temporary notes, files and saved messages', async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await register(browser, 'sa', 'Алиса', suffix);
  const bob = await register(browser, 'sb', 'Борис', suffix);
  const page = alice.page;

  // It is there from the start, pinned at the top of the chat list.
  await expect(page.locator('.chat-item').first()).toContainText('Избранное');
  await page.locator('.rail').getByRole('button', { name: 'Избранное' }).click();
  const vault = page.getByRole('region', { name: 'Избранное' });
  await expect(vault).toContainText('Только на этом ПК · ключ scrypt 128 МиБ');
  await expect(page.locator('.chat-header')).toHaveCount(0);

  const input = page.getByLabel('Заметка, пароль или ссылка — для себя');
  await input.fill('Купить билеты на 12 марта');
  await input.press('Enter');
  await expect(vault.getByTestId('vault-card').first()).toContainText('Купить билеты на 12 марта');

  // A password: hidden until «Показать», copied with clipboard clearing.
  await page.getByRole('switch', { name: 'Как пароль' }).click();
  await page.getByLabel('Для чего пароль').fill('Wi-Fi дома');
  await page.getByLabel('Пароль для сохранения').fill('sunflower-42');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  const password = vault.locator('[data-kind=password]').first();
  await expect(password).toContainText('Wi-Fi дома');
  await expect(password).not.toContainText('sunflower-42');
  await password.getByRole('button', { name: 'Показать' }).click();
  await expect(password).toContainText('sunflower-42');
  await password.getByRole('button', { name: 'Скрыть' }).click();
  await expect(page.getByTestId('chat-saved')).toContainText('Пароль · Wi-Fi дома');
  await expect(page.getByTestId('chat-saved')).not.toContainText('sunflower');

  // A link (no preview: Veil never opens it) and a temporary note.
  await input.fill('https://example.org/tickets');
  await input.press('Enter');
  await expect(vault.locator('[data-kind=link]').first()).toContainText('Без превью: Veil не открывал ссылку');
  await page.getByLabel('Сгорит через').selectOption('7');
  await input.fill('Код от подъезда 4521');
  await input.press('Enter');
  const temp = vault.locator('.vault-card.temp').first();
  await expect(temp).toContainText('Код от подъезда 4521');
  await expect(temp).toContainText('Сгорит через 6 дней');

  // A file.
  await page.locator('.vault-composer input[type=file]').setInputFiles({ name: 'договор.txt', mimeType: 'text/plain', buffer: Buffer.from('Договор аренды') });
  await page.getByRole('dialog').getByRole('button', { name: 'Отправить' }).click();
  await expect(vault.locator('[data-kind=file]').first()).toContainText('договор.txt');

  // Bob sends something worth keeping; Alice saves it via the context menu.
  await openChat(bob.page, alice.username);
  await send(bob.page, 'Встречаемся у фонтана в 18:00');
  await acceptRequest(page, bob.username);
  await page.locator('.messages').getByText('Встречаемся у фонтана в 18:00').click({ button: 'right' });
  await page.locator('.context-menu').getByRole('button', { name: 'В избранное' }).click();
  await expect(page.getByText('Сохранено в «Избранное»')).toBeVisible();
  await page.getByTestId('chat-saved').click();
  await vault.getByRole('tab', { name: /Из чатов/ }).click();
  await expect(vault.getByTestId('vault-card')).toHaveCount(1);
  await expect(vault.getByTestId('vault-card')).toContainText('Из чата · Борис');
  await vault.getByRole('tab', { name: /Пароли/ }).click();
  await expect(vault.getByTestId('vault-card')).toHaveCount(1);
  await vault.getByRole('tab', { name: 'Всё' }).click();
  await shot(page, '32-vault');

  // Copying the password: shortest clearing time, then the clipboard is empty again.
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Конфиденциальность' }).click();
  await page.getByLabel('Очищать буфер обмена').selectOption('15');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).first().click();
  await vault.locator('[data-kind=password]').getByRole('button', { name: 'Копировать' }).click();
  await expect(page.getByTestId('clipboard-notice')).toContainText('буфер очистится через');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('sunflower-42');
  await shot(page, '33-vault-clipboard');
  await expect(page.getByTestId('clipboard-notice')).toBeHidden({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 }).toBe('');

  // Typing your own username in "New chat" opens it too.
  await page.getByTestId(`chat-${bob.username}`).click();
  await openChat(page, alice.username);
  await expect(page.getByRole('region', { name: 'Избранное' })).toBeVisible();
});
