import { expect, test, type Page } from '@playwright/test';
import { acceptRequest, openChat, register, send, shot } from './helpers.ts';

// The fake camera (a moving test pattern) and an automatically picked screen.
test.use({
  launchOptions: {
    ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing'],
  },
});

/** The video element shows real frames (not a black, never-started track). */
const playing = (page: Page, label: string) =>
  expect
    .poll(() => page.getByLabel(label).evaluate((v: HTMLVideoElement) => v.videoWidth > 0 && v.readyState >= 2 && !v.paused), { timeout: 20_000 })
    .toBe(true);

test('video call: camera both ways, then screen sharing with Veil on', async ({ browser }) => {
  test.setTimeout(150_000);
  const suffix = Date.now().toString(36);
  const alice = await register(browser, 'vidalice', 'Алиса', suffix);
  const bob = await register(browser, 'vidbob', 'Борис', suffix);
  await openChat(alice.page, bob.username);
  await send(alice.page, 'Созвонимся с видео?');
  await acceptRequest(bob.page, alice.username);
  await send(bob.page, 'Да');
  await expect(alice.page.locator('.messages').getByText('Да', { exact: true })).toBeVisible();

  await alice.page.locator('.chat-header').getByRole('button', { name: 'Видеозвонок' }).click();
  await expect(bob.page.getByTestId('call-status')).toHaveText('Входящий видеозвонок');
  await bob.page.getByRole('button', { name: 'Ответить с видео' }).click();

  await expect(alice.page.getByTestId('call-stage')).toBeVisible({ timeout: 20_000 });
  await playing(alice.page, 'Ваша камера');
  await playing(alice.page, 'Камера: Борис');
  await playing(bob.page, 'Камера: Алиса');
  await shot(bob.page, 'video-call');

  // Bob switches his camera off: Alice sees his avatar instead.
  await bob.page.getByRole('button', { name: 'Выключить камеру' }).click();
  await expect(alice.page.getByText('Камера собеседника выключена')).toBeVisible();

  // Alice shows her screen: Bob sees it, Alice's chats are veiled and no notifications pop up.
  await alice.page.getByRole('button', { name: 'Показать экран' }).click();
  await expect(alice.page.getByText('Вы показываете экран')).toBeVisible();
  await playing(bob.page, 'Экран: Алиса');
  await expect(alice.page.locator('.shell.sharing')).toHaveCount(1);
  await alice.page.getByRole('button', { name: 'Свернуть звонок' }).click();
  await expect(alice.page.locator('.chat-item.veiled').first()).toBeVisible();
  await alice.page.getByRole('button', { name: 'Остановить показ экрана' }).click();
  await expect(alice.page.locator('.shell.sharing')).toHaveCount(0);
  await expect(bob.page.getByLabel('Экран: Алиса')).toHaveCount(0);

  await bob.page.getByRole('button', { name: 'Завершить звонок' }).click();
  await expect(alice.page.getByTestId('call-status')).toHaveText('Звонок завершён');
});
