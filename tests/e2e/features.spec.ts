import { expect, test, type Browser, type Page } from '@playwright/test';
import { base32Decode, totp } from '../../server/src/shared/totp.ts';

const SERVER = '127.0.0.1:8790';
const APP = 'http://127.0.0.1:5179';
const shotsDir = process.env.SCREENSHOTS;
const suffix = Date.now().toString(36).slice(-5);

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${shotsDir}/${name}.png` });
}

async function picture(page: Page, hue: number, label: string): Promise<Buffer> {
  const url = await page.evaluate(
    ([h, text]) => {
      const c = document.createElement('canvas');
      c.width = 480;
      c.height = 360;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, 480, 360);
      grad.addColorStop(0, `hsl(${h}, 80%, 62%)`);
      grad.addColorStop(1, `hsl(${(h as number) + 50}, 75%, 45%)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, 480, 360);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.font = 'bold 64px sans-serif';
      g.fillText(String(text), 40, 210);
      return c.toDataURL('image/png');
    },
    [hue, label] as const,
  );
  return Buffer.from(url.split(',')[1], 'base64');
}

async function stickerImage(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 300;
    const g = c.getContext('2d')!;
    g.font = '240px serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('🦊', 150, 165);
    return c.toDataURL('image/png');
  });
  return Buffer.from(url.split(',')[1], 'base64');
}

async function register(browser: Browser, profile: string, name: string) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto(`${APP}/?profile=${profile}-${suffix}`);
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Адрес сервера').fill(SERVER);
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.getByLabel('Имя', { exact: true }).fill(name);
  await page.getByLabel('Имя пользователя').fill(`${profile}_${suffix}`);
  await page.getByLabel('Пароль для входа').fill('Very-Secret-42');
  await page.getByLabel('Повторите пароль').fill('Very-Secret-42');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByText('Добро пожаловать')).toBeVisible({ timeout: 30_000 });
  return { page, username: `${profile}_${suffix}` };
}

const bubble = (page: Page, text: string) => page.locator('.msg-row', { has: page.locator('.bubble', { hasText: text }) }).last();

test('replies, reactions, copy, albums, stickers, voice, archive and 2FA', async ({ browser }) => {
  const alice = await register(browser, 'fa', 'Алиса');
  const bob = await register(browser, 'fb', 'Борис');

  await alice.page.getByRole('button', { name: 'Новый чат' }).first().click();
  await alice.page.getByLabel('Имя пользователя').fill(bob.username);
  await alice.page.getByRole('button', { name: 'Найти и открыть чат' }).click();
  const aliceComposer = alice.page.getByLabel('Сообщение', { exact: true });
  await aliceComposer.fill('Как прошли выходные?');
  await aliceComposer.press('Enter');

  await bob.page.getByTestId(`chat-${alice.username}`).click();
  await expect(bob.page.locator('.messages').getByText('Как прошли выходные?')).toBeVisible();

  // Presence: both are online.
  await expect(alice.page.locator('.chat-header .sub.online')).toHaveText('в сети');

  // Reply via the hover button.
  const question = bubble(bob.page, 'Как прошли выходные?');
  await question.hover();
  await question.getByRole('button', { name: 'Ответить' }).click();
  await expect(bob.page.locator('.reply-bar')).toContainText('Как прошли выходные?');
  const bobComposer = bob.page.getByLabel('Сообщение', { exact: true });
  await bobComposer.fill('Отлично! Ездили на море 🌊');
  await bobComposer.press('Enter');
  const reply = bubble(alice.page, 'Ездили на море');
  await expect(reply.locator('.quote')).toContainText('Вы');
  await expect(reply.locator('.quote')).toContainText('Как прошли выходные?');

  // Reactions: Alice picks 🔥 from the quick bar, Bob double-clicks for ❤️.
  await reply.hover();
  await reply.getByRole('button', { name: 'Реакция' }).click();
  await alice.page.locator('.reaction-picker').getByRole('button', { name: '🔥' }).click();
  await expect(bubble(bob.page, 'Ездили на море').locator('.reactions')).toContainText('🔥');
  await bubble(bob.page, 'Как прошли выходные?').locator('.bubble').dblclick();
  await expect(bubble(alice.page, 'Как прошли выходные?').locator('.reactions')).toContainText('❤️');

  // Copy button.
  await reply.hover();
  await reply.getByRole('button', { name: 'Копировать' }).click();
  await expect(alice.page.getByText('Текст скопирован')).toBeVisible();
  expect(await alice.page.evaluate(() => navigator.clipboard.readText())).toBe('Отлично! Ездили на море 🌊');

  // Album with a caption through the preview dialog.
  await bob.page.locator('.composer input[type=file]').setInputFiles([
    { name: 'sea.png', mimeType: 'image/png', buffer: await picture(bob.page, 190, 'Море') },
    { name: 'sun.png', mimeType: 'image/png', buffer: await picture(bob.page, 30, 'Закат') },
    { name: 'boat.png', mimeType: 'image/png', buffer: await picture(bob.page, 260, 'Лодка') },
  ]);
  const dialog = bob.page.getByRole('dialog');
  await expect(dialog).toContainText('Отправить 3 фото');
  await dialog.getByLabel('Подпись').fill('Фотки с моря ☀️');
  await shot(bob.page, '11-preview');
  await dialog.getByRole('button', { name: 'Отправить' }).click();
  const album = bubble(alice.page, 'Фотки с моря');
  await expect(album.locator('.album img')).toHaveCount(3);

  // Stickers: Bob adds his own, sends it, Alice saves it.
  await bob.page.getByRole('button', { name: 'Эмодзи и стикеры' }).click();
  await bob.page.getByRole('button', { name: 'Стикеры', exact: true }).click();
  await bob.page.locator('.sticker-grid input[type=file]').setInputFiles({ name: 'fox.png', mimeType: 'image/png', buffer: await stickerImage(bob.page) });
  await expect(bob.page.getByText('Стикер добавлен')).toBeVisible();
  await bob.page.locator('.sticker-cell:not(.add)').first().click();
  const sticker = alice.page.locator('.bubble.sticker-bubble img');
  await expect(sticker).toBeVisible();
  await sticker.click({ button: 'right' });
  await alice.page.getByRole('button', { name: 'Сохранить в мои стикеры' }).click();
  await expect(alice.page.getByText('Стикер сохранён')).toBeVisible();

  // Voice message (fake microphone).
  await bob.page.getByRole('button', { name: 'Записать голосовое' }).click();
  await expect(bob.page.locator('.composer.recording')).toBeVisible();
  await bob.page.waitForTimeout(1600);
  await bob.page.getByRole('button', { name: 'Отправить голосовое' }).click();
  await expect(alice.page.locator('.voice')).toBeVisible({ timeout: 15_000 });
  await expect(alice.page.locator('.voice-time')).toHaveText(/0:0[1-3]/);
  await shot(alice.page, '10-features');

  // Delete for everyone leaves no trace.
  const oops = 'Ой, не тот чат';
  await bobComposer.fill(oops);
  await bobComposer.press('Enter');
  await expect(alice.page.locator('.messages').getByText(oops)).toBeVisible();
  await bubble(bob.page, oops).locator('.bubble').click({ button: 'right' });
  await bob.page.getByRole('button', { name: 'Удалить у всех' }).click();
  await expect(alice.page.locator('.messages').getByText(oops)).toHaveCount(0);
  await expect(alice.page.locator('.messages').getByText('удалено')).toHaveCount(0);

  // Chat list actions: pin, then archive.
  const item = alice.page.getByTestId(`chat-${bob.username}`);
  await item.click({ button: 'right' });
  await alice.page.locator('.context-menu').getByRole('button', { name: 'Закрепить' }).click();
  await item.click({ button: 'right' });
  await shot(alice.page, '12-chat-menu');
  await alice.page.locator('.context-menu').getByRole('button', { name: 'В архив' }).click();
  await expect(alice.page.locator('.archive-row')).toBeVisible();
  await alice.page.locator('.archive-row').click();
  await expect(alice.page.getByTestId(`chat-${bob.username}`)).toBeVisible();
  await alice.page.getByRole('button', { name: 'Назад к чатам' }).click();

  // Two-factor authentication with an authenticator code.
  await alice.page.getByRole('button', { name: 'Настройки' }).click();
  await alice.page.getByRole('button', { name: 'Безопасность' }).click();
  await alice.page.getByRole('button', { name: 'Подключить Google Authenticator' }).click();
  const secret = (await alice.page.locator('.secret-row code').innerText()).replace(/\s/g, '');
  await shot(alice.page, '13-2fa');
  await alice.page.getByLabel('Код из приложения').fill(totp(base32Decode(secret)));
  await alice.page.getByRole('dialog').getByRole('button', { name: 'Включить' }).click();
  await expect(alice.page.getByText('Двухфакторная аутентификация включена')).toBeVisible();
  await alice.page.keyboard.press('Escape');
  await alice.page.locator('.rail').getByRole('button', { name: 'Заблокировать' }).click();
  await alice.page.getByLabel('Пароль', { exact: true }).fill('Very-Secret-42');
  await alice.page.getByRole('button', { name: 'Разблокировать' }).click();
  await expect(alice.page.getByText('Код подтверждения')).toBeVisible({ timeout: 20_000 });
  await alice.page.getByLabel('Код из Google Authenticator').fill('123456');
  await alice.page.getByRole('button', { name: 'Войти' }).click();
  await expect(alice.page.getByText('Неверный код')).toBeVisible();
  await shot(alice.page, '14-2fa-unlock');
  await alice.page.getByLabel('Код из Google Authenticator').fill(totp(base32Decode(secret)));
  await alice.page.getByRole('button', { name: 'Войти' }).click();
  await expect(alice.page.locator('.sidebar')).toBeVisible();
});
