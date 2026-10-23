import { expect, test } from '@playwright/test';
import { acceptRequest, bubble, openChat, register, send, shot } from './helpers.ts';

const suffix = Date.now().toString(36).slice(-5);

test('scheduled messages and time capsules', async ({ browser }) => {
  const alice = await register(browser, 'ta', 'Алиса', suffix);
  const bob = await register(browser, 'tb', 'Борис', suffix);
  await openChat(alice.page, bob.username);
  await send(alice.page, 'Привет!');
  await acceptRequest(bob.page, alice.username);
  await expect(bubble(bob.page, 'Привет!')).toBeVisible();

  const composer = alice.page.getByLabel('Сообщение', { exact: true });
  await composer.fill('Напоминаю про встречу');
  await alice.page.getByRole('button', { name: 'Отправить позже' }).click();
  await alice.page.getByRole('button', { name: 'Через час' }).click();
  const scheduled = alice.page.getByTestId('scheduled');
  await expect(scheduled).toContainText(/Отправится (сегодня|завтра) в/);
  await expect(alice.page.getByTestId(`chat-${bob.username}`)).toContainText('Запланировано: Напоминаю про встречу');
  await bob.page.waitForTimeout(500);
  await expect(bob.page.locator('.messages').getByText('Напоминаю про встречу')).toHaveCount(0);
  await scheduled.getByRole('button', { name: 'Отправить сейчас' }).click();
  await expect(bubble(bob.page, 'Напоминаю про встречу')).toBeVisible();

  await composer.fill('Откроешь в Новый год');
  await alice.page.getByRole('button', { name: 'Отправить позже' }).click();
  await alice.page.getByRole('button', { name: 'Отправить капсулу' }).click();
  await expect(alice.page.getByText(/Капсула отправлена · откроется 1 января/)).toBeVisible();
  const capsule = bob.page.getByTestId('capsule-card');
  await expect(capsule).toContainText('Капсула времени');
  await expect(capsule).toContainText('Откроется 1 января');
  await expect(bob.page.locator('.messages').getByText('Откроешь в Новый год')).toHaveCount(0);
  await expect(bubble(alice.page, 'Откроешь в Новый год')).toContainText('Откроешь в Новый год');
  await shot(bob.page, '43-capsule');
});
