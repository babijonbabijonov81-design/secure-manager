import { expect, test, type Page } from '@playwright/test';
import { createAccount } from '../../src/core/messenger.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { picture } from '../e2e/helpers.ts';

const SERVER = '127.0.0.1:8791';
const shots = process.env.SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/${name}.png` });
};

// The iPhone app and a desktop account (the same core, in Node) write to each other through the relay.
test('iPhone app: register, get a request from the desktop, reply, photo and wallpaper', async ({ page }) => {
  const suffix = Date.now().toString(36);
  await page.goto(`/?profile=phone-${suffix}`);
  await shot(page, 'm01-welcome');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Адрес сервера или приглашение').fill(SERVER);
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.getByLabel('Имя', { exact: true }).fill('Тимур');
  await page.getByLabel('Имя пользователя').fill(`phone_${suffix}`);
  await page.getByLabel('Пароль для входа').fill('Very-Secret-42');
  await page.getByLabel('Повторите пароль').fill('Very-Secret-42');
  await shot(page, 'm02-profile');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByRole('heading', { name: 'Чаты' })).toBeVisible({ timeout: 60_000 });

  // The desktop side writes first: on the phone it is a request.
  const desktop = await createAccount({
    storage: new MemoryStorage(),
    serverUrl: SERVER,
    username: `pc_${suffix}`,
    displayName: 'Максим',
    password: 'desktop-password',
    kdf: { N: 2 ** 10, r: 8, p: 1 },
  });
  await expect.poll(() => desktop.getSnapshot().status, { timeout: 15_000 }).toBe('online');
  const phone = await desktop.addContact(`phone_${suffix}`);
  await desktop.sendText(phone.id, 'Привет с компьютера! 🔒');

  await page.getByRole('button', { name: /Запросы на переписку/ }).click({ timeout: 20_000 });
  await page.getByRole('button', { name: /Максим/ }).click();
  await expect(page.getByText('Привет с компьютера! 🔒').last()).toBeVisible();
  await page.getByRole('button', { name: 'Принять' }).click();
  await page.getByLabel('Сообщение', { exact: true }).fill('Привет с iPhone 👋');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect
    .poll(() => desktop.getSnapshot().conversations[phone.id]?.some((m) => m.dir === 'in' && m.text === 'Привет с iPhone 👋'), { timeout: 20_000 })
    .toBe(true);
  await desktop.sendText(phone.id, 'Дошло. Сверим ключи вечером?');
  await expect(page.getByText('Дошло. Сверим ключи вечером?').last()).toBeVisible();
  await shot(page, 'm03-chat');

  // Safety number: the same digits as on the desktop.
  await page.getByRole('button', { name: /Максим: о чате/ }).click();
  const digits = desktop.safetyNumber(phone.id).match(/.{5}/g)!;
  await expect(page.getByLabel(`Код безопасности: ${digits.join(' ')}`)).toBeVisible();
  await shot(page, 'm04-info');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('button', { name: 'Назад к чатам' }).click();
  await shot(page, 'm05-chats');

  // «Ещё»: a profile photo reaches the desktop; a wallpaper stays here.
  await page.getByRole('tab', { name: 'Ещё' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Добавить фото' }).click();
  await (await chooser).setFiles({ name: 'me.png', mimeType: 'image/png', buffer: await picture(page, 150, 'Т', 600, 600) });
  await expect(page.getByText('Фото обновлено')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => desktop.getSnapshot().contacts.find((c) => c.id === phone.id)?.avatar, { timeout: 20_000 }).toBeTruthy();
  await page.getByRole('radio', { name: 'Угли' }).first().click();
  await expect(page.getByRole('radio', { name: 'Угли' }).first()).toHaveAttribute('aria-checked', 'true');
  await shot(page, 'm06-more');

  await page.getByRole('tab', { name: 'Сейф' }).click();
  await page.getByRole('button', { name: 'Добавить запись' }).click();
  await page.getByLabel('Текст').fill('Маршрут: Севастополь → Ай-Петри');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Маршрут: Севастополь → Ай-Петри')).toBeVisible();
  await shot(page, 'm07-vault');

  // Locked: the password opens it again.
  await page.getByRole('tab', { name: 'Чаты' }).click();
  await page.getByRole('button', { name: 'Заблокировать' }).click();
  await expect(page.getByRole('heading', { name: 'Veil закрыт' })).toBeVisible();
  await shot(page, 'm08-locked');
  await page.getByLabel('Пароль').fill('Very-Secret-42');
  await page.getByRole('button', { name: 'Открыть' }).click();
  await expect(page.getByRole('heading', { name: 'Чаты' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Дошло. Сверим ключи вечером?').first()).toBeVisible();
  desktop.dispose();
});
