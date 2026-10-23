import { expect, test } from '@playwright/test';
import { acceptRequest, bubble, openChat, picture, register, send, shot } from './helpers.ts';

const suffix = Date.now().toString(36).slice(-5);

test('Вуаль, Щит чата and view-once photos', async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await register(browser, 'pa', 'Алиса', suffix);
  const bob = await register(browser, 'pb', 'Максим', suffix, { colorScheme: 'light' });

  await openChat(alice.page, bob.username);
  await send(alice.page, 'Привет! Проверим новую защиту?');
  await acceptRequest(bob.page, alice.username);
  await send(bob.page, 'Конечно, присылай');
  await expect(bubble(alice.page, 'Конечно, присылай')).toBeVisible();

  // Щит чата: the score, honest items, links to settings.
  const shield = alice.page.getByTestId('chat-shield');
  await expect(shield).toContainText('из 6');
  await expect(alice.page.getByTestId('shield-screen')).toContainText('Только в приложении для ПК');
  await expect(alice.page.getByTestId('shield-badge')).toHaveAccessibleName(/Щит чата: \d из 6/);
  await alice.page.getByTestId('shield-ip').click();
  await expect(alice.page.getByRole('dialog').getByRole('heading', { name: 'Аудио' })).toBeVisible();
  await alice.page.keyboard.press('Escape');

  // Вуаль: incoming text blurred until hovered, Ctrl+Shift+V toggles it.
  const incoming = bubble(alice.page, 'Конечно, присылай').locator('.bubble .text');
  await expect(incoming).toHaveCSS('filter', 'none');
  await alice.page.locator('.messages').click({ position: { x: 10, y: 10 } });
  await alice.page.keyboard.press('Control+Shift+V');
  await expect(alice.page.locator('.rail').getByRole('button', { name: 'Вуаль' })).toHaveAttribute('aria-pressed', 'true');
  await alice.page.mouse.move(5, 400);
  await expect(incoming).toHaveCSS('filter', /blur/);
  await expect(alice.page.getByTestId(`chat-${bob.username}`).locator('.preview')).toHaveCSS('filter', /blur/);
  await bubble(alice.page, 'Конечно, присылай').locator('.bubble').hover();
  await expect(incoming).toHaveCSS('filter', 'none');
  await alice.page.mouse.move(5, 400);
  await bubble(alice.page, 'Конечно, присылай').locator('.bubble').focus();
  await expect(incoming).toHaveCSS('filter', 'none');
  await shot(alice.page, '30-veil');
  await alice.page.locator('.rail').getByRole('button', { name: 'Вуаль' }).click();
  await expect(incoming).toHaveCSS('filter', 'none');

  // View-once photo from Bob.
  const png = await picture(bob.page, 30, 'Один раз');
  await bob.page.locator('.composer input[type=file]').setInputFiles({ name: 'secret.png', mimeType: 'image/png', buffer: png });
  const dialog = bob.page.getByRole('dialog');
  await dialog.getByRole('switch', { name: 'Открыть один раз' }).click();
  await dialog.getByRole('button', { name: 'Отправить' }).click();
  await expect(bob.page.getByTestId('once-card')).toContainText('Фото · откроется один раз');
  const card = alice.page.getByTestId('once-card');
  await expect(card).toContainText('Фото · откроется один раз');
  await expect(alice.page.getByTestId(`chat-${bob.username}`)).toContainText('Фото · один просмотр');
  await shot(alice.page, '31-once-card');
  await card.click();
  const viewer = alice.page.getByRole('dialog', { name: 'Просмотр один раз' });
  await expect(viewer.locator('img')).toBeVisible();
  await expect(viewer).toContainText('Открывается один раз');
  await viewer.getByRole('button', { name: 'Закрыть' }).click();
  await expect(card).toContainText('Фото открыто');
  await expect(card).toBeDisabled();
  await expect(bob.page.getByTestId('once-card')).toContainText('Открыто');

  // No copying, saving or forwarding.
  await card.click({ button: 'right', force: true });
  const menu = alice.page.locator('.context-menu');
  await expect(menu.getByRole('button', { name: 'В избранное' })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: /Сохранить|Копировать/ })).toHaveCount(0);
});
