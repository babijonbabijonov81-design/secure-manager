import { expect, test } from '@playwright/test';
import { register, SERVER, shot } from './helpers.ts';

// Settings → «Аккаунты»: a second account on the same device, switching on the lock screen, signing out.
test('two accounts on one device', async ({ browser }) => {
  const suffix = Date.now().toString(36);
  const { page, username } = await register(browser, 'acfirst', 'Первая', suffix);

  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Аккаунты' }).click();
  const tab = page.getByTestId('accounts-tab');
  await expect(tab).toContainText('1 из 2');
  await tab.getByRole('button', { name: 'Добавить аккаунт' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Продолжить' }).click();

  // The second account, with its own password.
  await expect(page.getByTestId('add-account')).toBeVisible();
  await shot(page, 'accounts-add');
  await page.getByRole('button', { name: 'Создать новый аккаунт' }).click();
  await page.getByLabel('Адрес сервера').fill(SERVER);
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.getByLabel('Имя', { exact: true }).fill('Вторая');
  await page.getByLabel('Имя пользователя').fill(`acsecond_${suffix}`);
  await page.getByLabel('Пароль для входа').fill('Other-Secret-77');
  await page.getByLabel('Повторите пароль').fill('Other-Secret-77');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByText('Добро пожаловать')).toBeVisible({ timeout: 30_000 });

  // Switch back: the first account asks for its own password, the second one's does not open it.
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Аккаунты' }).click();
  await expect(tab).toContainText('2 из 2');
  await shot(page, 'accounts-tab');
  await tab.getByRole('button', { name: 'Переключиться' }).click();
  const picker = page.getByRole('tablist', { name: 'Аккаунт' });
  await expect(picker.getByRole('tab', { selected: true })).toContainText('Первая');
  await shot(page, 'accounts-lock');
  await page.getByLabel('Пароль', { exact: true }).fill('Other-Secret-77');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await expect(page.getByText('Неверный пароль')).toBeVisible();
  await page.getByLabel('Пароль', { exact: true }).fill('Very-Secret-42');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Аккаунты' }).click();
  await expect(tab.locator('.account-row.current')).toContainText(`@${username}`);

  // Signing out needs the password, and warns that nothing else can bring this account back.
  await tab.getByRole('button', { name: 'Выйти из аккаунта' }).click();
  const dialog = page.getByTestId('sign-out');
  await expect(dialog).toContainText('Ключи этого аккаунта есть только здесь');
  await dialog.getByLabel('Пароль Veil').fill('Very-Secret-42');
  await expect(dialog.getByRole('button', { name: 'Выйти', exact: true })).toBeDisabled();
  await dialog.getByLabel('Понимаю, переписка будет потеряна').check();
  await shot(page, 'accounts-signout');
  await dialog.getByRole('button', { name: 'Выйти', exact: true }).click();

  // Only the second account is left, on its lock screen.
  await expect(page.getByRole('button', { name: 'Разблокировать' })).toBeVisible();
  await expect(picker).toHaveCount(0);
  await page.getByLabel('Пароль', { exact: true }).fill('Other-Secret-77');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Аккаунты' }).click();
  await expect(tab).toContainText('1 из 2');
  await expect(tab.locator('.account-row.current')).toContainText(`@acsecond_${suffix}`);
});
