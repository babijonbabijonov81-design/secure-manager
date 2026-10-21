import { expect, test } from '@playwright/test';
import { openChat, register, shot } from './helpers.ts';

// «Приглашение veil://»: Alice makes a link, Bob pastes it — both sides are verified at once.
test('a veil:// invite verifies both sides', async ({ browser }) => {
  const suffix = Date.now().toString(36);
  const alice = await register(browser, 'invalice', 'Алиса', suffix);
  const bob = await register(browser, 'invbob', 'Борис', suffix);

  await alice.page.getByRole('button', { name: 'Новый чат' }).first().click();
  await alice.page.getByRole('button', { name: 'Пригласить лично' }).click();
  const panel = alice.page.getByTestId('invite-panel');
  await expect(panel.getByRole('img', { name: 'QR-код приглашения' })).toBeVisible();
  const link = (await alice.page.getByTestId('invite-link').textContent())!.trim();
  expect(link).toMatch(new RegExp(`^veil://add/${alice.username}\\?k=`));
  await shot(alice.page, 'invite');
  await alice.page.keyboard.press('Escape');

  await bob.page.getByRole('button', { name: 'Новый чат' }).first().click();
  await bob.page.getByLabel('Имя пользователя').fill(link);
  await bob.page.getByRole('button', { name: 'Добавить по приглашению' }).click();
  await expect(bob.page.getByText(/Контакт добавлен по приглашению «(Алиса|invalice_\w+)»/).first()).toBeVisible();
  await expect(bob.page.getByText('Сверен приглашением').first()).toBeVisible();

  // Alice: Bob's first message carried the token back — he is verified on her side as well.
  await alice.page.getByRole('listitem').filter({ hasText: 'Борис' }).click();
  await expect(alice.page.locator('.sys-msg').getByText('«Борис» открыл(а) ваше приглашение')).toBeVisible();
  await expect(alice.page.getByText('Сверен приглашением').first()).toBeVisible();

  // A forged link (Alice's name with Bob's key) is refused.
  const forged = link.replace(/k=[^&]+/, `k=${'A'.repeat(43)}`);
  await openChat(bob.page, alice.username);
  await bob.page.getByRole('button', { name: 'Новый чат' }).first().click();
  await bob.page.getByLabel('Имя пользователя').fill(forged);
  await bob.page.getByRole('button', { name: 'Добавить по приглашению' }).click();
  await expect(bob.page.getByText(/Ключ не совпадает с приглашением|Сервер вернул неверные ключи|не приглашение/)).toBeVisible();
});
