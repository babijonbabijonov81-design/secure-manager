import { expect, test } from '@playwright/test';
import { APP, bubble, openChat, register, send, SERVER, shot } from './helpers.ts';

const suffix = Date.now().toString(36).slice(-5);

test('«Мост»: move the account to another computer through the relay', async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await register(browser, 'ba', 'Алиса', suffix);
  const bob = await register(browser, 'bb', 'Борис', suffix);
  await openChat(alice.page, bob.username);
  await send(alice.page, 'Сообщение до переезда');
  await bob.page.getByTestId(`chat-${alice.username}`).click();
  await expect(bubble(bob.page, 'Сообщение до переезда')).toBeVisible();

  // Old computer: Settings → Устройства → Мост.
  const old = alice.page;
  await old.getByRole('button', { name: 'Настройки' }).click();
  await old.getByRole('button', { name: 'Устройства' }).click();
  await expect(old.getByTestId('device-row').first()).toContainText('Этот ПК');
  await old.getByTestId('bridge-start').click();
  await expect(old.getByText('После переноса Veil на этом ПК очистится')).toBeVisible();
  await old.getByRole('button', { name: 'Начать перенос' }).click();
  const code = (await old.getByTestId('bridge-code').innerText()).trim();
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await shot(old, '40-bridge-code');

  // New computer: onboarding → «Перенести с другого ПК».
  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto(`${APP}/?profile=bn-${suffix}`);
  await fresh.getByRole('button', { name: 'Перенести с другого ПК' }).click();
  await fresh.getByLabel('Пароль для этого ПК', { exact: true }).fill('New-Computer-77');
  await fresh.getByLabel('Повторите пароль для этого ПК').fill('New-Computer-77');
  await fresh.getByRole('button', { name: 'Дальше' }).click();
  await fresh.getByLabel('Адрес сервера для переноса').fill(SERVER);
  await fresh.getByRole('button', { name: 'Дальше' }).click();
  await fresh.getByLabel('Код переноса').fill(code.toLowerCase());
  await fresh.getByRole('button', { name: 'Подключиться' }).click();

  // The same six digits on both screens; nothing moves until the old computer confirms.
  const sasNew = (await fresh.getByTestId('bridge-sas').innerText()).replace(/\s/g, '');
  const sasOld = (await old.getByTestId('bridge-sas').innerText()).replace(/\s/g, '');
  expect(sasNew).toMatch(/^\d{6}$/);
  expect(sasOld).toBe(sasNew);
  await shot(fresh, '41-bridge-sas');
  await old.getByRole('button', { name: 'Цифры совпадают' }).click();

  await expect(fresh.getByText('Добро пожаловать')).toBeVisible({ timeout: 30_000 });
  await expect(old.getByText('Перенос завершён')).toBeVisible();
  await old.getByRole('button', { name: 'Очистить этот ПК' }).click();
  await expect(old.getByRole('button', { name: 'Создать аккаунт' })).toBeVisible();

  // The chat continues on the new computer.
  await fresh.getByTestId(`chat-${bob.username}`).click();
  await expect(bubble(fresh, 'Сообщение до переезда')).toBeVisible();
  await send(bob.page, 'Вижу, ты на новом компьютере');
  await expect(bubble(fresh, 'Вижу, ты на новом компьютере')).toBeVisible({ timeout: 20_000 });
  await send(fresh, 'Да, всё переехало');
  await expect(bubble(bob.page, 'Да, всё переехало')).toBeVisible();
});
