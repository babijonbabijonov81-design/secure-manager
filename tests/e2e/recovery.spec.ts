import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const SERVER = '127.0.0.1:8790';
const APP = 'http://127.0.0.1:5179';
const shotsDir = process.env.SCREENSHOTS;
const suffix = Date.now().toString(36).slice(-5);

function lastCode(email: string): string {
  const lines = readFileSync(process.env.VEIL_E2E_MAIL!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const mail = lines.filter((m) => m.to === email).at(-1);
  return /(\d{6})/.exec(mail?.text ?? '')?.[1] ?? '';
}

test('recover an account on a new device by email', async ({ browser }) => {
  const username = `rec_${suffix}`;
  const email = `rec_${suffix}@example.com`;
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${APP}/?profile=rec-old-${suffix}`);
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Адрес сервера').fill(SERVER);
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.getByLabel('Имя', { exact: true }).fill('Вера');
  await page.getByLabel('Имя пользователя').fill(username);
  await page.getByLabel('Пароль для входа').fill('Very-Secret-42');
  await page.getByLabel('Повторите пароль').fill('Very-Secret-42');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByText('Добро пожаловать')).toBeVisible({ timeout: 30_000 });

  // Link a recovery email.
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Безопасность' }).click();
  await page.getByRole('button', { name: 'Указать почту' }).click();
  await page.getByLabel('Почта', { exact: true }).fill(email);
  await page.getByLabel('Пароль Veil').fill('Very-Secret-42');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await expect(page.getByText('Мы отправили 6-значный код')).toBeVisible();
  await page.getByLabel('Код из письма').fill(lastCode(email));
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText('Почта подтверждена')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Резервная копия .*обновлена/)).toBeVisible();
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/15-security.png` });

  // A brand-new device.
  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto(`${APP}/?profile=rec-new-${suffix}`);
  await fresh.getByRole('button', { name: 'У меня уже есть аккаунт — восстановить по почте' }).click();
  await fresh.getByLabel('Адрес сервера').fill(SERVER);
  await fresh.getByLabel('Имя пользователя').fill(username);
  await fresh.getByLabel('Почта').fill(email);
  await fresh.getByRole('button', { name: 'Получить код' }).click();
  // The code step appears only after the relay has sent (logged) the recovery email.
  await expect(fresh.getByLabel('Код из письма')).toBeVisible({ timeout: 20_000 });
  await fresh.getByLabel('Код из письма').fill(lastCode(email));
  await fresh.getByRole('button', { name: 'Продолжить' }).click();
  await fresh.getByLabel('Пароль').fill('wrong-password');
  await fresh.getByRole('button', { name: 'Восстановить' }).click();
  await expect(fresh.getByText('Неверный пароль')).toBeVisible({ timeout: 20_000 });
  if (shotsDir) await fresh.screenshot({ path: `${shotsDir}/16-recovery.png` });
  await fresh.getByLabel('Пароль').fill('Very-Secret-42');
  await fresh.getByRole('button', { name: 'Восстановить' }).click();
  await expect(fresh.getByText('Добро пожаловать, Вера')).toBeVisible({ timeout: 30_000 });
});
