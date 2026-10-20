import { expect, test, type Browser, type Page } from '@playwright/test';

const SERVER = '127.0.0.1:8790';
const APP = 'http://127.0.0.1:5179';
const shotsDir = process.env.SCREENSHOTS;
const suffix = Date.now().toString(36).slice(-5);

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  await page.waitForTimeout(900); // let entrance animations settle
  await page.screenshot({ path: `${shotsDir}/${name}.png` });
}

/** Paints a small landscape picture in the browser to use as an attachment. */
async function makePicture(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 420;
    const g = c.getContext('2d')!;
    const sky = g.createLinearGradient(0, 0, 0, 420);
    sky.addColorStop(0, '#2b1055');
    sky.addColorStop(0.55, '#d7598b');
    sky.addColorStop(1, '#ffb88c');
    g.fillStyle = sky;
    g.fillRect(0, 0, 640, 420);
    g.fillStyle = '#ffe9a8';
    g.beginPath();
    g.arc(420, 250, 70, 0, Math.PI * 2);
    g.fill();
    const ridge = (color: string, base: number, amp: number, seed: number) => {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(0, 420);
      for (let x = 0; x <= 640; x += 16) g.lineTo(x, base - Math.abs(Math.sin(x / 90 + seed)) * amp - Math.sin(x / 23 + seed) * 8);
      g.lineTo(640, 420);
      g.fill();
    };
    ridge('#5b2a6e', 330, 90, 1);
    ridge('#3a1a4f', 370, 70, 2.4);
    ridge('#1d0f2e', 405, 40, 4);
    return c.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function register(browser: Browser, profile: string, name: string, screenshots = false) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto(`${APP}/?profile=${profile}-${suffix}`);
  await expect(page.getByText('Мессенджер, в котором ваши слова')).toBeVisible();
  if (screenshots) await shot(page, '01-welcome');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();

  await page.getByLabel('Адрес сервера').fill(SERVER);
  if (screenshots) await shot(page, '02-server');
  await page.getByRole('button', { name: 'Продолжить' }).click();

  await page.getByLabel('Имя', { exact: true }).fill(name);
  await page.getByLabel('Имя пользователя').fill(`${profile}_${suffix}`);
  await page.getByLabel('Пароль для входа').fill('Very-Secret-42');
  await page.getByLabel('Повторите пароль').fill('Very-Secret-42');
  if (screenshots) await shot(page, '03-profile');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByText('Добро пожаловать')).toBeVisible({ timeout: 30_000 });
  return { page, username: `${profile}_${suffix}` };
}

test('two people chat end-to-end through the relay', async ({ browser }) => {
  const alice = await register(browser, 'alice', 'Алиса', true);
  await shot(alice.page, '04-empty');
  const bob = await register(browser, 'bob', 'Борис');

  // Alice opens a chat with Bob and writes.
  await alice.page.getByRole('button', { name: 'Новый чат' }).first().click();
  await alice.page.getByLabel('Имя пользователя').fill(bob.username);
  await alice.page.getByRole('button', { name: 'Найти и открыть чат' }).click();
  const composer = alice.page.getByLabel('Сообщение', { exact: true });
  await composer.fill('Привет! Это сообщение зашифровано 🔒');
  await composer.press('Enter');
  await composer.fill('Даже сервер не может его прочитать.');
  await composer.press('Enter');

  // Bob receives it, opens the chat and replies.
  const chatItem = bob.page.getByTestId(`chat-${alice.username}`);
  await expect(chatItem).toContainText('Даже сервер не может его прочитать.');
  await expect(chatItem).toContainText('Алиса');
  await chatItem.click();
  await expect(bob.page.locator('.messages').getByText('Привет! Это сообщение зашифровано 🔒')).toBeVisible();
  const bobComposer = bob.page.getByLabel('Сообщение', { exact: true });
  await bobComposer.fill('Привет, Алиса! Отлично работает 🎉');
  await bobComposer.press('Enter');
  await bobComposer.fill('👍');
  await bobComposer.press('Enter');

  await expect(alice.page.locator('.messages').getByText('Привет, Алиса! Отлично работает 🎉')).toBeVisible();
  // Bob has the chat open, so Alice sees her messages as read.
  await expect(alice.page.locator('[aria-label="Прочитано"]').first()).toBeVisible();

  // Typing indicator. Wait for Bob's last message first: its arrival clears the indicator.
  await expect(alice.page.locator('.messages').getByText('👍', { exact: true })).toBeVisible();
  await bobComposer.pressSequentially('Сейчас пришлю', { delay: 30 });
  await expect(alice.page.locator('.chat-header .sub.typing')).toBeVisible();
  await bobComposer.press('Enter');
  await expect(alice.page.locator('.messages').getByText('Сейчас пришлю')).toBeVisible();

  // Image attachment.
  const png = await makePicture(bob.page);
  await bob.page.locator('.composer input[type=file]').setInputFiles({ name: 'sunset.png', mimeType: 'image/png', buffer: png });
  await bob.page.getByRole('dialog').getByRole('button', { name: 'Отправить' }).click();
  await expect(alice.page.locator('.bubble.media img')).toBeVisible();
  await expect.poll(() => alice.page.locator('.bubble.media img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(600);
  await alice.page.locator('.messages').getByText('Сейчас пришлю').waitFor();
  await bobComposer.fill('Закат с дачи 🌅');
  await bobComposer.press('Enter');
  await expect(alice.page.locator('.messages').getByText('Закат с дачи 🌅')).toBeVisible();

  await shot(alice.page, '05-chat');

  // Safety numbers match on both sides.
  await alice.page.getByRole('button', { name: 'Информация о чате' }).click();
  await bob.page.getByRole('button', { name: 'Информация о чате' }).click();
  const aliceCode = await alice.page.getByTestId('safety-number').innerText();
  const bobCode = await bob.page.getByTestId('safety-number').innerText();
  expect(aliceCode.replace(/\s/g, '')).toMatch(/^\d{60}$/);
  expect(aliceCode).toBe(bobCode);
  await alice.page.getByRole('button', { name: 'Коды совпадают — отметить как проверенный' }).click();
  await alice.page.getByRole('button', { name: '1 ч' }).click();
  await expect(bob.page.getByText('включил(а) исчезающие сообщения: 1 ч')).toBeVisible();
  await alice.page.locator('.panel-body').evaluate((el) => (el.scrollTop = 0));
  await shot(alice.page, '06-info');

  // Settings and light theme.
  await alice.page.getByRole('button', { name: 'Настройки' }).click();
  await alice.page.getByRole('button', { name: 'Оформление' }).click();
  await alice.page.getByRole('button', { name: 'Светлая' }).click();
  await alice.page.getByRole('button', { name: 'teal' }).click();
  await shot(alice.page, '07-settings');
  await alice.page.keyboard.press('Escape');
  await shot(alice.page, '08-light');

  // Lock and unlock: history is decrypted again from local storage.
  await alice.page.locator('.rail').getByRole('button', { name: 'Заблокировать' }).click();
  await expect(alice.page.getByText('Veil заблокирован')).toBeVisible();
  await alice.page.getByLabel('Пароль', { exact: true }).fill('wrong-password');
  await alice.page.getByRole('button', { name: 'Разблокировать' }).click();
  await expect(alice.page.getByText('Неверный пароль')).toBeVisible({ timeout: 20_000 });
  await shot(alice.page, '09-lock');
  await alice.page.getByLabel('Пароль', { exact: true }).fill('Very-Secret-42');
  await alice.page.getByRole('button', { name: 'Разблокировать' }).click();
  await alice.page.getByTestId(`chat-${bob.username}`).click({ timeout: 20_000 });
  await expect(alice.page.locator('.messages').getByText('Привет, Алиса! Отлично работает 🎉')).toBeVisible();
});
