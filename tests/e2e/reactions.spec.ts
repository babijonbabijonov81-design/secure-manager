import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { acceptRequest } from './helpers.ts';

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

const bubble = (page: Page, text: string) => page.locator('.msg-row', { has: page.locator('.bubble', { hasText: text }) }).last();

/** Moves the mouse like a person does (many small steps, crossing any gaps) and clicks. */
async function humanClick(page: Page, target: Locator) {
  await target.click({ trial: true }); // waits until it is visible and has stopped animating
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
  await page.mouse.down();
  await page.mouse.up();
}

async function openPicker(page: Page, row: Locator) {
  const box = (await row.locator('.bubble').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await humanClick(page, row.getByRole('button', { name: 'Реакция' }));
  const picker = page.locator('.reaction-picker');
  await expect(picker).toBeVisible();
  return picker;
}

test('reaction picker opens from the button and stays usable', async ({ browser }) => {
  const alice = await register(browser, 'ra', 'Алиса');
  const bob = await register(browser, 'rb', 'Борис');

  await alice.page.getByRole('button', { name: 'Новый чат' }).first().click();
  await alice.page.getByLabel('Имя пользователя').fill(bob.username);
  await alice.page.getByRole('button', { name: 'Найти и открыть чат' }).click();
  const composer = alice.page.getByLabel('Сообщение', { exact: true });
  for (const text of ['Первое сообщение', 'Привет! Как дела?']) {
    await composer.fill(text);
    await composer.press('Enter');
  }
  await acceptRequest(bob.page, alice.username);
  await expect(bob.page.locator('.messages').getByText('Привет! Как дела?')).toBeVisible();

  // The bar slides out of the button and survives moving the mouse onto it.
  const page = bob.page;
  const row = bubble(page, 'Привет! Как дела?');
  let picker = await openPicker(page, row);
  await page.waitForTimeout(400);
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/17-reactions.png` });
  const bar = (await picker.boundingBox())!;
  const own = (await row.locator('.bubble').boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(own.y);
  await humanClick(page, picker.getByRole('button', { name: 'Реакция 😂' }));
  await expect(picker).toBeHidden();
  await expect(row.locator('.reactions')).toContainText('😂');
  await expect(bubble(alice.page, 'Привет! Как дела?').locator('.reactions')).toContainText('😂');

  // "+" shows the full set; picking one replaces the previous reaction.
  picker = await openPicker(page, row);
  await expect(picker.getByRole('button', { name: 'Реакция 😂' })).toHaveClass(/active/);
  await humanClick(page, picker.getByRole('button', { name: 'Другие реакции' }));
  await expect(picker.getByRole('button', { name: 'Реакция 🎉' })).toBeVisible();
  if (shotsDir) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${shotsDir}/18-reactions-more.png` });
  }
  await humanClick(page, picker.getByRole('button', { name: 'Реакция 🎉' }));
  await expect(row.locator('.reactions')).toHaveText('🎉');
  await expect(bubble(alice.page, 'Привет! Как дела?').locator('.reactions')).toHaveText('🎉');

  // Escape and a click elsewhere close it without reacting; the button toggles it.
  picker = await openPicker(page, row);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  picker = await openPicker(page, row);
  await humanClick(page, page.locator('.chat-header'));
  await expect(picker).toBeHidden();
  picker = await openPicker(page, row);
  await humanClick(page, row.getByRole('button', { name: 'Реакция' }));
  await expect(picker).toBeHidden();

  // Clicking my reaction chip removes it.
  await humanClick(page, row.locator('.reactions button'));
  await expect(row.locator('.reactions')).toHaveCount(0);
  await expect(bubble(alice.page, 'Привет! Как дела?').locator('.reactions')).toHaveCount(0);

  // The picker stays inside the window even for the topmost message.
  const first = bubble(page, 'Первое сообщение');
  await page.locator('.messages').evaluate((el) => (el.scrollTop = 0));
  picker = await openPicker(page, first);
  const pickerBox = (await picker.boundingBox())!;
  const listBox = (await page.locator('.messages').boundingBox())!;
  expect(pickerBox.y).toBeGreaterThanOrEqual(0);
  expect(pickerBox.x).toBeGreaterThanOrEqual(0);
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(listBox.y + listBox.height);
  await humanClick(page, picker.getByRole('button', { name: 'Реакция 👍' }));
  await expect(first.locator('.reactions')).toContainText('👍');

  // Right-click menu offers the quick reactions too.
  const aliceRow = bubble(alice.page, 'Привет! Как дела?');
  await aliceRow.locator('.bubble').click({ button: 'right' });
  if (shotsDir) await alice.page.screenshot({ path: `${shotsDir}/19-reactions-menu.png` });
  await humanClick(alice.page, alice.page.locator('.context-menu').getByRole('button', { name: 'Реакция ❤️' }));
  await expect(alice.page.locator('.context-menu')).toBeHidden();
  await expect(bubble(page, 'Привет! Как дела?').locator('.reactions')).toContainText('❤️');
});
