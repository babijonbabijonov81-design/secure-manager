import { expect, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

export const SERVER = '127.0.0.1:8790';
export const APP = 'http://127.0.0.1:5179';
const shotsDir = process.env.SCREENSHOTS;

/** Screenshots for the docs, taken only when SCREENSHOTS=<dir> is set. */
export async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${shotsDir}/${name}.png` });
}

export async function register(browser: Browser, profile: string, name: string, suffix: string, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], ...options });
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
  return { page, context, username: `${profile}_${suffix}` };
}

/** Opens (or creates) the chat with `username` and sends a text. */
export async function openChat(page: Page, username: string) {
  await page.getByRole('button', { name: 'Новый чат' }).first().click();
  await page.getByLabel('Имя пользователя').fill(username);
  await page.getByRole('button', { name: 'Найти и открыть чат' }).click();
}

/** The first message from someone new lands in «Запросы на переписку»: open it and accept. */
export async function acceptRequest(page: Page, username: string) {
  await page.getByTestId('requests-row').click({ timeout: 20_000 });
  await page.getByTestId(`chat-${username}`).click();
  await page.getByTestId('request-panel').getByRole('button', { name: 'Принять' }).click();
  await expect(page.getByTestId('request-panel')).toHaveCount(0);
}

export async function send(page: Page, text: string) {
  const composer = page.getByLabel('Сообщение', { exact: true });
  await composer.fill(text);
  await composer.press('Enter');
}

/** A generated picture with a label, as PNG bytes. */
export async function picture(page: Page, hue: number, label: string, width = 640, height = 480): Promise<Buffer> {
  const url = await page.evaluate(
    ([h, text, w, hh]) => {
      const c = document.createElement('canvas');
      c.width = w as number;
      c.height = hh as number;
      const g = c.getContext('2d')!;
      g.fillStyle = `hsl(${h}, 70%, 55%)`;
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.font = 'bold 64px sans-serif';
      g.fillText(String(text), 40, c.height / 2);
      return c.toDataURL('image/png');
    },
    [hue, label, width, height] as const,
  );
  return Buffer.from(url.split(',')[1], 'base64');
}

export const bubble = (page: Page, text: string) => page.locator('.msg-row', { has: page.locator('.bubble', { hasText: text }) }).last();
