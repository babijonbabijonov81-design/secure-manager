// Launches the built desktop app, creates an account against the embedded relay and
// takes a screenshot. Run after `npm run build` (on Linux CI: under xvfb-run).
//   node tests/electron/smoke.mjs [screenshot.png] [card.png] [call-card.png]
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';

const home = mkdtempSync(join(tmpdir(), 'veil-smoke-'));
const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  env: { ...process.env, VEIL_PROFILE: `smoke${process.pid}`, HOME: home, XDG_CONFIG_HOME: home, APPDATA: home, VEIL_TEST_KEYCHAIN: '1' },
});
try {
  const page = await app.firstWindow();
  await page.getByText('Мессенджер, в котором ваши слова').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByRole('switch', { name: 'Свой сервер' }).click();
  await page.locator('.addresses code').first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.getByLabel('Имя', { exact: true }).fill('Smoke Test');
  await page.getByLabel('Имя пользователя').fill('smoke_test');
  await page.getByLabel('Пароль для входа').fill('Smoke-Test-123');
  await page.getByLabel('Повторите пароль').fill('Smoke-Test-123');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByText('Добро пожаловать').waitFor({ timeout: 60_000 });
  await page.getByText('В сети').waitFor({ timeout: 15_000 });
  const bridge = await page.evaluate(() => ({ platform: window.veil?.platform, version: window.veil?.version }));
  console.log('desktop bridge:', JSON.stringify(bridge));

  // Clipboard through the main process.
  await page.evaluate(() => window.veil.copyText('Привет из Veil'));
  await page.waitForTimeout(300);
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  if (copied !== 'Привет из Veil') throw new Error(`clipboard: ${copied}`);
  console.log('clipboard ok');

  // A password copied from «Избранное» is erased after the timeout, but only if still there.
  await page.evaluate(() => window.veil.copySecret('пароль-для-смоук-теста', 1));
  if ((await app.evaluate(({ clipboard }) => clipboard.readText())) !== 'пароль-для-смоук-теста') throw new Error('secret copy');
  await page.waitForTimeout(1600);
  if ((await app.evaluate(({ clipboard }) => clipboard.readText())) !== '') throw new Error('secret not cleared');
  await page.evaluate(() => window.veil.copySecret('второй-пароль', 1));
  await app.evaluate(({ clipboard }) => clipboard.writeText('чужой текст'));
  await page.waitForTimeout(1600);
  if ((await app.evaluate(({ clipboard }) => clipboard.readText())) !== 'чужой текст') throw new Error('cleared somebody else\'s text');
  console.log('clipboard clearing ok');

  // Quick unlock reports the keychain honestly; system lock detection answers.
  const quick = await page.evaluate(() => window.veil.quickUnlock.status());
  const systemLock = await page.evaluate(() => window.veil.systemLockSupported());
  console.log('quick unlock:', JSON.stringify(quick), 'system lock:', systemLock);
  if (quick.keychain === 'none' && quick.available) throw new Error('quick unlock without a keychain');

  // Spellchecker bridge must not throw even without dictionaries.
  await page.evaluate(() => window.veil.spell.suggestions('превет'));

  // A Veil notification card in the corner of the screen.
  await page.evaluate(() =>
    window.veil.notify({
      title: 'Алиса',
      body: 'Привет! Как дела?',
      tag: 'x',
      card: { title: 'Алиса', body: 'Привет! Как дела? Это новое уведомление Veil.', initials: 'АЛ', gradient: 'linear-gradient(135deg, #ff6b8b, #ff9a5a)', theme: 'dark', accent: '#7c5cff' },
    }),
  );
  const card = await app.waitForEvent('window', { predicate: (w) => w.url().includes('card.html'), timeout: 10_000 });
  await card.getByText('Привет! Как дела?').waitFor({ timeout: 10_000 });
  console.log('notification card ok');
  if (process.argv[3]) {
    await card.waitForTimeout(600);
    await card.screenshot({ path: process.argv[3], omitBackground: true });
  }

  // An incoming-call card: its buttons reach the app, then the card closes.
  await page.evaluate(() => {
    window.__callActions = [];
    window.veil.onCallAction((a) => window.__callActions.push(a));
    window.veil.notify({
      title: 'Алиса',
      body: 'Входящий аудиозвонок',
      tag: 'call:smoke',
      card: { title: 'Алиса', body: 'Входящий аудиозвонок', initials: 'АЛ', gradient: 'linear-gradient(135deg, #ff6b8b, #ff9a5a)', theme: 'dark', accent: '#7c5cff', call: true },
    });
  });
  const callCard = await app.waitForEvent('window', { predicate: (w) => w.url().includes('card.html') && w !== card, timeout: 10_000 });
  await callCard.getByRole('button', { name: 'Ответить' }).waitFor({ timeout: 10_000 });
  if (process.argv[4]) {
    await callCard.waitForTimeout(600);
    await callCard.screenshot({ path: process.argv[4], omitBackground: true });
  }
  await callCard.getByRole('button', { name: 'Ответить' }).click();
  await page.waitForFunction(() => window.__callActions.length > 0, null, { timeout: 5000 });
  const action = await page.evaluate(() => window.__callActions[0]);
  if (action.tag !== 'call:smoke' || action.action !== 'accept') throw new Error(`call action: ${JSON.stringify(action)}`);
  console.log('call card ok');

  // «При сворачивании в трей»: closing the window hides it and locks Veil; notification cards go.
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Конфиденциальность' }).click();
  await page.getByRole('switch', { name: 'Блокировать при сворачивании в трей' }).click();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).first().click();
  await page.evaluate(() =>
    window.veil.notify({ title: 'Алиса', body: 'Секрет', tag: 'y', card: { title: 'Алиса', body: 'Секрет в карточке', initials: 'АЛ', gradient: '#e2582a', theme: 'dark', accent: '#ff7a45' } }),
  );
  await app.waitForEvent('window', { predicate: (w) => w.url().includes('card.html'), timeout: 10_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('card.html'))?.close());
  await page.getByText('Veil заблокирован').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const cards = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('card.html') && w.isVisible()).length);
  if (cards) throw new Error(`${cards} notification cards still on screen after locking`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('card.html'))?.show());
  await page.getByLabel('Пароль', { exact: true }).fill('Smoke-Test-123');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await page.getByText('Добро пожаловать').waitFor({ timeout: 60_000 });
  console.log('lock on hide ok');

  // Quick unlock with a PIN: wrong PIN counts down, the right one opens the vault.
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Безопасность' }).click();
  await page.getByRole('switch', { name: 'Вход по PIN' }).click();
  await page.getByLabel('Пароль Veil').fill('Smoke-Test-123');
  await page.getByLabel('Новый PIN').fill('482913');
  await page.getByLabel('Повторите PIN').fill('482913');
  await page.getByRole('button', { name: 'Включить' }).click();
  await page.getByTestId('quick-unlock').getByText('PIN включён').waitFor({ timeout: 20_000 });
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const stored = readFileSync(join(userData, 'quick-unlock.json'), 'utf8');
  if (stored.includes('482913')) throw new Error('PIN stored in plain text');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).first().click();
  await page.locator('.rail').getByRole('button', { name: 'Заблокировать' }).click();
  await page.getByLabel('PIN', { exact: true }).fill('111111');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await page.getByText('Неверный PIN. Осталось попыток: 4').waitFor({ timeout: 20_000 });
  await page.getByLabel('PIN', { exact: true }).fill('482913');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await page.getByText('Добро пожаловать').waitFor({ timeout: 30_000 });
  console.log('quick unlock with PIN ok');

  // A veil:// link opened by the system while Veil runs (a second copy is started with it).
  const link = `veil://add/smoke_friend?k=${'A'.repeat(43)}`;
  await app.evaluate(({ app: a }, url) => a.emit('second-instance', {}, ['veil', url], {}), link);
  await page.getByTestId('open-invite').getByText('@smoke_friend').waitFor({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  console.log('veil:// link ok');

  const maximized = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isMaximized()));
  console.log('maximized on first launch:', maximized);
  if (process.argv[2]) {
    await page.waitForTimeout(800);
    await page.screenshot({ path: process.argv[2] });
  }
  console.log('smoke test passed');
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
