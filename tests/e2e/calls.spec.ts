import { expect, test, type Browser, type Page } from '@playwright/test';

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

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shotsDir}/${name}.png` });
}

const status = (page: Page) => page.getByTestId('call-status');
const records = (page: Page) => page.getByTestId('call-record');

test('audio calls: ring, answer, talk, mute, hang up, decline, missed', async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await register(browser, 'ca', 'Алиса');
  const bob = await register(browser, 'cb', 'Борис');

  await alice.page.getByRole('button', { name: 'Новый чат' }).first().click();
  await alice.page.getByLabel('Имя пользователя').fill(bob.username);
  await alice.page.getByRole('button', { name: 'Найти и открыть чат' }).click();
  const aliceComposer = alice.page.getByLabel('Сообщение', { exact: true });
  await aliceComposer.fill('Созвонимся?');
  await aliceComposer.press('Enter');
  await bob.page.getByTestId(`chat-${alice.username}`).click();
  const bobComposer = bob.page.getByLabel('Сообщение', { exact: true });
  await bobComposer.fill('Давай!');
  await bobComposer.press('Enter');
  await expect(alice.page.locator('.messages').getByText('Давай!')).toBeVisible();

  // Voice processing would filter out the fake microphone's steady beep that proves audio flows.
  await alice.page.getByRole('button', { name: 'Настройки' }).click();
  await alice.page.getByRole('button', { name: 'Аудио' }).click();
  for (const name of ['Шумоподавление', 'Эхоподавление', 'Автоматическая громкость']) {
    const toggle = alice.page.getByRole('switch', { name });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  }
  await alice.page.getByRole('button', { name: 'Закрыть' }).first().click();

  // 1. Alice calls, Bob answers, they talk.
  await alice.page.locator('.chat-header').getByRole('button', { name: 'Позвонить' }).click();
  await expect(status(alice.page)).toHaveText(/Вызов…|Ожидание ответа…/);
  await expect(status(bob.page)).toHaveText('Входящий аудиозвонок');
  await expect(status(alice.page)).toHaveText('Ожидание ответа…');
  await shot(bob.page, '20-call-incoming');
  await bob.page.getByRole('button', { name: 'Принять звонок' }).click();
  await expect(status(alice.page)).toHaveText(/^\d+:\d\d/, { timeout: 30_000 });
  await expect(status(bob.page)).toHaveText(/^\d+:\d\d/, { timeout: 30_000 });

  // Audio really flows: the fake microphone's short beeps make the other avatar glow
  // (a silent stream reads exactly 0).
  await expect
    .poll(() => bob.page.locator('.call-avatar').evaluate((el) => Number(getComputedStyle(el).getPropertyValue('--level')) || 0), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await shot(alice.page, '21-call-active');

  await alice.page.getByRole('button', { name: 'Выключить микрофон' }).click();
  await expect(status(alice.page)).toContainText('микрофон выключен');
  await alice.page.getByRole('button', { name: 'Включить микрофон' }).click();

  // Minimized to a bar, the chat stays usable.
  await alice.page.getByRole('button', { name: 'Свернуть звонок' }).click();
  await expect(alice.page.locator('.call-bar')).toBeVisible();
  await aliceComposer.fill('Пишу во время звонка');
  await aliceComposer.press('Enter');
  await expect(bob.page.locator('.messages').getByText('Пишу во время звонка')).toBeAttached();
  await shot(alice.page, '22-call-bar');
  await alice.page.getByRole('button', { name: 'Развернуть звонок' }).click();

  await bob.page.waitForTimeout(1200); // make the call last at least a second
  await bob.page.getByRole('button', { name: 'Завершить звонок' }).click();
  await expect(status(alice.page)).toHaveText('Звонок завершён');
  await expect(alice.page.locator('.call-overlay')).toBeHidden({ timeout: 10_000 });
  await expect(records(alice.page).last()).toContainText('Исходящий звонок');
  await expect(records(alice.page).last()).toContainText(/сек|мин/);
  await expect(records(bob.page).last()).toContainText('Входящий звонок');

  // 2. Bob calls back from the call record, Alice declines.
  await expect(bob.page.locator('.call-overlay')).toBeHidden({ timeout: 10_000 });
  await records(bob.page).last().getByRole('button', { name: 'Перезвонить' }).click();
  await expect(status(alice.page)).toHaveText('Входящий аудиозвонок');
  await alice.page.getByRole('button', { name: 'Отклонить звонок' }).click();
  await expect(status(bob.page)).toHaveText('Абонент отклонил звонок');
  await expect(records(bob.page).last()).toContainText('Звонок отклонён');
  await expect(records(alice.page).last()).toContainText('Отклонённый звонок');

  // 3. Alice calls and changes her mind: Bob gets a missed call.
  await expect(alice.page.locator('.call-overlay')).toBeHidden({ timeout: 10_000 });
  await expect(bob.page.locator('.call-overlay')).toBeHidden({ timeout: 10_000 });
  await alice.page.locator('.chat-header').getByRole('button', { name: 'Позвонить' }).click();
  await expect(status(bob.page)).toHaveText('Входящий аудиозвонок');
  await alice.page.getByRole('button', { name: 'Завершить звонок' }).click();
  await expect(records(bob.page).last()).toContainText('Пропущенный звонок');
  await expect(records(bob.page).last().locator('.call-bubble')).toHaveClass(/missed/);
  await expect(records(alice.page).last()).toContainText('Отменённый звонок');
  await expect(bob.page.locator('.call-overlay')).toBeHidden({ timeout: 10_000 });
  await shot(bob.page, '23-call-history');

  // Settings → Audio lists the microphones and shows the input level.
  await bob.page.getByRole('button', { name: 'Настройки' }).click();
  await bob.page.getByRole('button', { name: 'Аудио' }).click();
  const mic = bob.page.getByLabel('Микрофон', { exact: true });
  await expect.poll(() => mic.locator('option').count()).toBeGreaterThan(1);
  const device = await mic.locator('option').nth(1).getAttribute('value');
  await mic.selectOption(device!);
  await expect(mic).toHaveValue(device!);
  await expect(bob.page.getByText('Скажите что-нибудь — полоска должна двигаться.')).toBeVisible();
  // The level meter runs on the chosen microphone. (The fake device's beep is often filtered
  // to silence, so only check that the meter is live, not how loud it is.)
  await expect.poll(() => bob.page.locator('.mic-meter').evaluate((el) => el.style.getPropertyValue('--level'))).not.toBe('');
  await shot(bob.page, '24-audio-settings');
  await bob.page.getByRole('button', { name: 'Закрыть' }).first().click();

  // The chosen microphone is used for the next call.
  await bob.page.locator('.chat-header').getByRole('button', { name: 'Позвонить' }).click();
  await expect(status(alice.page)).toHaveText('Входящий аудиозвонок');
  await alice.page.getByRole('button', { name: 'Принять звонок' }).click();
  await expect(status(bob.page)).toHaveText(/^\d+:\d\d/, { timeout: 30_000 });
  await alice.page.getByRole('button', { name: 'Завершить звонок' }).click();
  await expect(status(bob.page)).toHaveText('Звонок завершён');
});
