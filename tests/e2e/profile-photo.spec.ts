import { expect, test } from '@playwright/test';
import { acceptRequest, openChat, picture, register, send, shot } from './helpers.ts';

// Фото профиля и обои: Alice sets a photo, Bob sees it; backgrounds stay on Alice's device.
test('profile photo with who-sees-it, and chat wallpapers', async ({ browser }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36);
  const alice = await register(browser, 'phalice', 'Алиса', suffix);
  const bob = await register(browser, 'phbob', 'Борис', suffix);
  await openChat(alice.page, bob.username);
  await send(alice.page, 'Привет');
  await acceptRequest(bob.page, alice.username);
  await send(bob.page, 'Привет!');
  await expect(alice.page.locator('.messages').getByText('Привет!')).toBeVisible();

  // Alice: Settings → Профиль → Добавить фото.
  await alice.page.getByRole('button', { name: 'Настройки' }).click();
  await alice.page.getByRole('dialog').getByRole('button', { name: 'Профиль' }).click();
  await alice.page.getByLabel('Фото профиля').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: await picture(alice.page, 20, 'А', 800, 600) });
  await expect(alice.page.getByText('Фото обновлено')).toBeVisible();
  await expect(alice.page.getByRole('radio', { name: 'Всем собеседникам' })).toHaveAttribute('aria-checked', 'true');
  await shot(alice.page, 'profile-photo');

  // Bob sees the photo in the chat list.
  const bobsList = bob.page.getByTestId(`chat-${alice.username}`).locator('.avatar.photo img');
  await expect(bobsList).toBeVisible({ timeout: 20_000 });

  // «Никому»: the photo disappears at Bob's.
  await alice.page.getByRole('radio', { name: 'Никому' }).click();
  await expect(bobsList).toHaveCount(0, { timeout: 20_000 });
  await alice.page.getByRole('radio', { name: 'Всем собеседникам' }).click();
  await expect(bobsList).toBeVisible({ timeout: 20_000 });

  // Wallpapers: «Угли» for all chats, slightly dimmed.
  await alice.page.getByRole('dialog').getByRole('button', { name: 'Оформление' }).click();
  await alice.page.getByTestId('wallpaper-all').getByRole('radio', { name: 'Угли' }).click();
  await expect(alice.page.getByTestId('wallpaper-all').getByRole('radio', { name: 'Угли' })).toHaveAttribute('aria-checked', 'true');
  await alice.page.getByLabel('Затемнение обоев').fill('0.2');
  await alice.page.getByRole('button', { name: 'Закрыть', exact: true }).first().click();
  const bg = alice.page.getByTestId('chat-bg');
  await expect(bg).toHaveClass(/wall/);
  expect(await bg.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('radial-gradient');
  await shot(alice.page, 'wallpaper');
  // Bob's chat keeps the default background.
  await expect(bob.page.getByTestId('chat-bg')).not.toHaveClass(/wall/);
});
