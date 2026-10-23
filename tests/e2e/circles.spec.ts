import { expect, test } from '@playwright/test';
import { acceptRequest, openChat, register, send, shot } from './helpers.ts';

// «Кружки»: Alice records a round video with the fake camera; Bob watches it in the chat.
test('a circle is recorded, sent and played', async ({ browser }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36);
  const alice = await register(browser, 'cralice', 'Алиса', suffix);
  const bob = await register(browser, 'crbob', 'Борис', suffix);
  await openChat(alice.page, bob.username);
  await send(alice.page, 'Смотри');
  await acceptRequest(bob.page, alice.username);

  await alice.page.getByRole('button', { name: 'Записать кружок' }).click();
  const recorder = alice.page.getByTestId('circle-recorder');
  await expect(recorder).toBeVisible();
  await expect(recorder.getByRole('button', { name: 'Отправить кружок' })).toBeEnabled({ timeout: 15_000 });
  await alice.page.waitForTimeout(2500);
  await shot(alice.page, 'circle-recording');
  await recorder.getByRole('button', { name: 'Отправить кружок' }).click();
  await expect(recorder).toHaveCount(0);

  // Bob: the circle is in the chat, its video decodes and plays silently; a click turns the sound on.
  const circle = bob.page.getByTestId('circle');
  await expect(circle).toBeVisible({ timeout: 20_000 });
  await expect(bob.page.getByTestId(`chat-${alice.username}`)).toContainText('Кружок');
  await expect
    .poll(() => circle.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth === 384 && v.readyState >= 2), { timeout: 15_000 })
    .toBe(true);
  await circle.click();
  await expect(circle).toHaveAttribute('aria-label', 'Пауза');
  expect(await circle.locator('video').evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  await shot(bob.page, 'circle');

  // Cancelling sends nothing.
  await alice.page.getByRole('button', { name: 'Записать кружок' }).click();
  await expect(alice.page.getByTestId('circle-recorder')).toBeVisible();
  await alice.page.getByRole('button', { name: 'Удалить кружок' }).click();
  await expect(alice.page.getByTestId('circle-recorder')).toHaveCount(0);
  await expect(alice.page.getByTestId('circle')).toHaveCount(1);
});
