import { expect, test, type Browser } from '@playwright/test';

const SERVER = '127.0.0.1:8790';
const APP = 'http://127.0.0.1:5179';
const shotsDir = process.env.SCREENSHOTS;
const suffix = Date.now().toString(36).slice(-5);

async function register(browser: Browser, profile: string, name: string) {
  const page = await (await browser.newContext()).newPage();
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

test('«Избранное»: notes, files and messages saved from other chats', async ({ browser }) => {
  const alice = await register(browser, 'sa', 'Алиса');
  const bob = await register(browser, 'sb', 'Борис');
  const page = alice.page;

  // It is there from the start, pinned at the top of the chat list.
  await expect(page.locator('.chat-item').first()).toContainText('Избранное');

  await page.getByRole('button', { name: 'Избранное' }).click();
  await expect(page.locator('.chat-header')).toContainText('Избранное');
  await expect(page.locator('.chat-header')).toContainText('только на этом устройстве');
  await expect(page.locator('.chat-header').getByRole('button', { name: 'Позвонить' })).toHaveCount(0);
  await expect(page.locator('.saved-card')).toBeVisible();

  const composer = page.getByLabel('Сообщение', { exact: true });
  await composer.fill('Пароль от Wi-Fi: sunflower-42');
  await composer.press('Enter');
  const note = page.locator('.msg-row', { hasText: 'Пароль от Wi-Fi' });
  await expect(note).toBeVisible();
  await expect(note.locator('.meta svg')).toHaveCount(0); // nothing is sent, so no ticks

  await page.locator('.composer input[type=file]').setInputFiles({ name: 'договор.txt', mimeType: 'text/plain', buffer: Buffer.from('Договор аренды') });
  await page.getByRole('dialog').getByRole('button', { name: 'Отправить' }).click();
  await expect(page.locator('.messages .file-card')).toContainText('договор.txt');
  await expect(page.getByTestId('chat-saved')).toContainText('договор.txt');
  await expect(page.getByTestId('chat-saved').locator('.ticks')).toHaveCount(0);

  // Bob sends something worth keeping; Alice saves it via the context menu.
  await bob.page.getByRole('button', { name: 'Новый чат' }).first().click();
  await bob.page.getByLabel('Имя пользователя').fill(alice.username);
  await bob.page.getByRole('button', { name: 'Найти и открыть чат' }).click();
  const bobComposer = bob.page.getByLabel('Сообщение', { exact: true });
  await bobComposer.fill('Код от домофона: 4521');
  await bobComposer.press('Enter');
  await page.getByTestId(`chat-${bob.username}`).click();
  await page.locator('.messages').getByText('Код от домофона: 4521').click({ button: 'right' });
  await page.locator('.context-menu').getByRole('button', { name: 'В избранное' }).click();
  await expect(page.getByText('Сохранено в «Избранное»')).toBeVisible();

  await page.getByTestId('chat-saved').click();
  const saved = page.locator('.msg-row', { hasText: 'Код от домофона: 4521' });
  await expect(saved.locator('.fwd')).toHaveText(/Переслано от Борис/);
  if (shotsDir) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${shotsDir}/25-saved.png` });
  }

  // Typing your own username in "New chat" opens it too.
  await page.getByTestId(`chat-${bob.username}`).click();
  await page.getByRole('button', { name: 'Новый чат' }).first().click();
  await page.getByLabel('Имя пользователя').fill(alice.username);
  await page.getByRole('button', { name: 'Найти и открыть чат' }).click();
  await expect(page.locator('.chat-header')).toContainText('Избранное');
});
