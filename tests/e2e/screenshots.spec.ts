import { expect, test, type Page } from '@playwright/test';
import { APP, openChat, register, send } from './helpers.ts';

// Screenshots of the main screens for README, in the dark and the light theme.
//   SCREENSHOTS=docs/screenshots npx playwright test tests/e2e/screenshots.spec.ts
const dir = process.env.SCREENSHOTS;

for (const theme of ['dark', 'light'] as const) {
  test(`screens in the ${theme} theme`, async ({ browser }) => {
    test.skip(!dir, 'only with SCREENSHOTS=<folder>');
    test.setTimeout(240_000);
    const suffix = `${theme[0]}${Date.now().toString(36).slice(-5)}`;
    const options = { colorScheme: theme };
    const snap = async (p: Page, name: string) => {
      await p.mouse.move(5, 5);
      await p.waitForTimeout(700);
      await p.screenshot({ path: `${dir}/${theme}-${name}.png` });
    };

    // The first screen of a new installation.
    const fresh = await (await browser.newContext(options)).newPage();
    await fresh.goto(`${APP}/?profile=welcome-${suffix}`);
    await expect(fresh.getByRole('button', { name: 'Создать аккаунт' })).toBeVisible();
    await snap(fresh, 'welcome');
    await fresh.context().close();

    const anna = await register(browser, 'anna', 'Анна', suffix, options);
    const boris = await register(browser, 'boris', 'Борис', suffix, options);
    const vera = await register(browser, 'vera', 'Вера', suffix, options);
    const page = anna.page;

    // Boris and Vera write first, so Anna sees their names.
    await openChat(boris.page, anna.username);
    await send(boris.page, 'Привет! Взял билеты на поезд, вагон 7 🚆');
    await openChat(vera.page, anna.username);
    await send(vera.page, 'Аня, карту маршрута скинула на почту');
    await page.getByTestId(`chat-${boris.username}`).click();
    await expect(page.locator('.messages').getByText('Взял билеты на поезд')).toBeVisible();
    await send(page, 'Отлично! Во сколько отправление?');
    await send(boris.page, 'В 8:40 с Ленинградского. Не опаздывай 😄');
    await expect(page.locator('.messages').getByText('В 8:40 с Ленинградского')).toBeVisible();
    await send(page, 'Буду в 8:15 у табло');
    await page.locator('.messages').getByText('В 8:40 с Ленинградского').dblclick();

    // «Избранное» as a vault.
    await page.locator('.rail').getByRole('button', { name: 'Избранное' }).click();
    const input = page.getByLabel('Заметка, пароль или ссылка — для себя');
    await input.fill('Список в поход: спальник, фонарик, термос');
    await input.press('Enter');
    await page.getByRole('switch', { name: 'Как пароль' }).click();
    await page.getByLabel('Для чего пароль').fill('Wi-Fi на даче');
    await page.getByLabel('Пароль для сохранения').fill('sunflower-42');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.getByLabel('Сгорит через').selectOption('7');
    await input.fill('Код камеры хранения 4521');
    await input.press('Enter');
    await expect(page.locator('.vault-card.temp')).toBeVisible();
    await snap(page, 'vault');

    // A group with everyone.
    await page.locator('.rail').getByRole('button', { name: 'Чаты' }).click();
    await page.getByRole('button', { name: 'Новый чат' }).first().click();
    await page.getByRole('button', { name: 'Новая группа' }).click();
    const create = page.getByTestId('group-create');
    await create.getByLabel('Название группы').fill('Поход на Ладогу');
    await create.getByText(`@${boris.username}`).click();
    await create.getByText(`@${vera.username}`).click();
    await create.getByRole('button', { name: /Создать группу/ }).click();
    await send(page, 'Кто берёт палатку?');
    for (const [p, text] of [
      [boris.page, 'Я — палатку и котелок'],
      [vera.page, 'С меня карта и аптечка 🗺️'],
    ] as const) {
      await p.getByRole('listitem').filter({ hasText: 'Поход на Ладогу' }).click();
      await expect(p.locator('.messages').getByText('Кто берёт палатку?')).toBeVisible();
      await send(p, text);
      await expect(page.locator('.messages').getByText(text)).toBeVisible();
    }
    await snap(page, 'group');

    // A personal chat with the shield.
    await page.getByTestId(`chat-${boris.username}`).click();
    await expect(page.getByTestId('chat-shield')).toBeVisible();
    await snap(page, 'chat');

    // Search across all chats.
    await page.keyboard.press('Control+k');
    await page.getByLabel('Поиск чатов').fill('карт');
    await expect(page.getByTestId('search-hit').first()).toBeVisible();
    await snap(page, 'search');
    await page.getByLabel('Поиск чатов').press('Escape');

    // An invite with the key inside.
    await page.getByRole('button', { name: 'Новый чат' }).first().click();
    await page.getByRole('button', { name: 'Пригласить лично' }).click();
    await expect(page.getByRole('img', { name: 'QR-код приглашения' })).toBeVisible();
    await snap(page, 'invite');
    await page.keyboard.press('Escape');

    // Settings: security and the switches for every feature.
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByRole('button', { name: 'Безопасность' }).click();
    await expect(page.getByTestId('protection-bar')).toBeVisible();
    await snap(page, 'security');
    await page.getByRole('button', { name: 'Функции' }).click();
    await snap(page, 'features');
    await page.getByRole('button', { name: 'Закрыть', exact: true }).first().click();

    // The lock screen.
    await page.locator('.rail').getByRole('button', { name: 'Заблокировать' }).click();
    await expect(page.getByRole('button', { name: 'Разблокировать' })).toBeVisible();
    await snap(page, 'lock');
  });
}
