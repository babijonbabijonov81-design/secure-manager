// Launches the built desktop app, creates an account against the embedded relay and
// takes a screenshot. Run after `npm run build` (on Linux CI: under xvfb-run).
//   node tests/electron/smoke.mjs [screenshot.png] [card.png] [call-card.png] [voice-text.png]
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';

const home = mkdtempSync(join(tmpdir(), 'veil-smoke-'));
// A step that never returns must fail the run, not hold CI until it is cancelled.
let lastStep = 'start';
const step = (text) => {
  lastStep = text;
  console.log(text);
};
const watchdog = setTimeout(() => {
  console.error(`smoke test hung after «${lastStep}»`);
  process.exit(1);
}, Number(process.env.SMOKE_TIMEOUT_MS) || 6 * 60_000);
watchdog.unref();
// SMOKE_EXECUTABLE=release/linux-unpacked/veil-messenger checks the packaged app instead.
const packaged = process.env.SMOKE_EXECUTABLE;
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged, args: ['--no-sandbox'] } : { args: ['.', '--no-sandbox'] }),
  env: { ...process.env, VEIL_PROFILE: `smoke${process.pid}`, HOME: home, XDG_CONFIG_HOME: home, APPDATA: home, VEIL_TEST_KEYCHAIN: '1', VEIL_MS_CLIENT_ID: '11111111-2222-3333-4444-555555555555' },
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
  step('clipboard ok');

  // A password copied from «Избранное» is erased after the timeout, but only if still there.
  await page.evaluate(() => window.veil.copySecret('пароль-для-смоук-теста', 1));
  if ((await app.evaluate(({ clipboard }) => clipboard.readText())) !== 'пароль-для-смоук-теста') throw new Error('secret copy');
  await page.waitForTimeout(1600);
  if ((await app.evaluate(({ clipboard }) => clipboard.readText())) !== '') throw new Error('secret not cleared');
  await page.evaluate(() => window.veil.copySecret('второй-пароль', 1));
  await app.evaluate(({ clipboard }) => clipboard.writeText('чужой текст'));
  await page.waitForTimeout(1600);
  if ((await app.evaluate(({ clipboard }) => clipboard.readText())) !== 'чужой текст') throw new Error('cleared somebody else\'s text');
  step('clipboard clearing ok');

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
  step('notification card ok');
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
  step('call card ok');

  // «При сворачивании в трей»: closing the window hides it and locks Veil; notification cards go.
  lastStep = 'lock on hide: turning it on';
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Конфиденциальность' }).click();
  await page.getByRole('switch', { name: 'Блокировать при сворачивании в трей' }).click();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).first().click();
  await page.evaluate(() =>
    window.veil.notify({ title: 'Алиса', body: 'Секрет', tag: 'y', card: { title: 'Алиса', body: 'Секрет в карточке', initials: 'АЛ', gradient: '#e2582a', theme: 'dark', accent: '#ff7a45' } }),
  );
  await app.waitForEvent('window', { predicate: (w) => w.url().includes('card.html'), timeout: 10_000 });
  lastStep = 'lock on hide: closing the window';
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('card.html'))?.close());
  lastStep = 'lock on hide: waiting for the lock screen';
  await page.getByText('Veil заблокирован').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const cards = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('card.html') && w.isVisible()).length);
  if (cards) throw new Error(`${cards} notification cards still on screen after locking`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('card.html'))?.show());
  await page.getByLabel('Пароль', { exact: true }).fill('Smoke-Test-123');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await page.getByText('Добро пожаловать').waitFor({ timeout: 60_000 });
  step('lock on hide ok');

  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  // Quick unlock with a PIN: wrong PIN counts down, the right one opens the vault. A packaged
  // build uses the real system keychain, which a bare CI display may not have.
  if (quick.available) {
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Безопасность' }).click();
  await page.getByRole('switch', { name: 'Вход по PIN' }).click();
  await page.getByLabel('Пароль Veil').fill('Smoke-Test-123');
  await page.getByLabel('Новый PIN').fill('482913');
  await page.getByLabel('Повторите PIN').fill('482913');
  await page.getByRole('button', { name: 'Включить' }).click();
  await page.getByTestId('quick-unlock').getByText('PIN включён').waitFor({ timeout: 20_000 });
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
  step('quick unlock with PIN ok');
  } else console.log('quick unlock skipped: no system keychain here');

  // «Копия в OneDrive»: offered in Settings → Безопасность when the build has a client ID (here
  // through VEIL_MS_CLIENT_ID; a packaged build without one says so instead).
  const cloud = await page.evaluate(() => window.veil.cloud.status());
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Безопасность' }).click();
  const cloudSection = page.getByTestId('cloud-backup');
  await cloudSection.getByText(cloud.configured ? 'Подключить OneDrive' : 'вход через Microsoft не настроен').waitFor({ timeout: 10_000 });
  // An upload never goes out without a sign-in: a bad token is refused before any file is read.
  const refused = await page.evaluate(() => window.veil.cloud.upload('x', '../evil.veil', new Uint8Array(4)).then((r) => (r.ok ? 'sent' : r.code)));
  if (refused !== 'failed') throw new Error(`cloud upload with a bad name: ${refused}`);
  await page.getByRole('button', { name: 'Закрыть', exact: true }).first().click();
  console.log('onedrive section ok:', cloud.configured ? 'configured' : 'not configured');

  // «Показ экрана»: Veil's picker lists the screens (X11 here; Wayland would use the portal).
  const screens = await page.evaluate(() => window.veil.screen.sources());
  if (!screens.portal && !screens.sources.some((s) => s.kind === 'screen' && s.thumbnail.startsWith('data:image/'))) throw new Error('no screens to share');
  await page.evaluate((id) => window.veil.screen.choose(id), screens.sources[0]?.id ?? null);
  const shared = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const ok = stream.getVideoTracks().length === 1;
    stream.getTracks().forEach((t) => t.stop());
    return ok;
  });
  if (!shared) throw new Error('getDisplayMedia did not get the chosen screen');
  console.log('screen sharing source ok:', screens.portal ? 'portal' : `${screens.sources.length} sources`);

  // A call keeps running while the window is minimized or hidden: no background throttling, so
  // the shared screen and the camera do not freeze. Timers in a hidden page are the telltale.
  const ticksWhileHidden = async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))?.hide());
    await page.waitForTimeout(500);
    const ticks = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let n = 0;
          const t = setInterval(() => n++, 50);
          setTimeout(() => {
            clearInterval(t);
            resolve(n);
          }, 2000);
        }),
    );
    const visible = await page.evaluate(() => document.visibilityState);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))?.show());
    return { ticks, visible };
  };
  const idle = await ticksWhileHidden();
  await page.evaluate(() => window.veil.setCallActive(true));
  await page.waitForTimeout(200);
  const throttling = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))?.webContents.getBackgroundThrottling());
  const calling = await ticksWhileHidden();
  await page.evaluate(() => window.veil.setCallActive(false));
  console.log('hidden window, no call:', JSON.stringify(idle), 'in a call:', JSON.stringify(calling), 'throttling in call:', throttling);
  if (throttling !== false) throw new Error('background throttling stays on during a call');
  if (calling.ticks < 25) throw new Error(`a hidden window is throttled during a call (${calling.ticks} ticks in 2 s)`);
  await page.getByText('Добро пожаловать').waitFor({ timeout: 10_000 });

  // «Голосовые в текст»: the bundled ONNX runtime runs Whisper from <userData>/models through
  // veil-model://, under the app's CSP. Needs a model folder (Xenova/whisper-tiny layout):
  //   VEIL_TEST_MODEL=/path/to/whisper-tiny node tests/electron/smoke.mjs
  if (process.env.VEIL_TEST_MODEL && existsSync(process.env.VEIL_TEST_MODEL)) {
    const models = await page.evaluate(() => window.veil.models.status());
    if (models.tiny.installed) throw new Error('model installed before consent');
    cpSync(process.env.VEIL_TEST_MODEL, join(userData, 'models', 'Xenova', 'whisper-tiny'), { recursive: true });
    if (!(await page.evaluate(() => window.veil.models.status())).tiny.installed) throw new Error('model not seen');
    // The packaged app is built from the same out/ folder.
    const worker = readdirSync(join('out', 'renderer', 'assets')).find((f) => f.startsWith('transcribe.worker'));
    const speech = [...readFileSync(join('tests', 'fixtures', 'speech-en.ogg'))];
    const started = Date.now();
    const text = await page.evaluate(
      async ({ worker, speech }) => {
        const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(new Uint8Array(speech).buffer);
        const audio = new Float32Array(decoded.getChannelData(0));
        const w = new Worker(`./assets/${worker}`, { type: 'module' });
        const reply = await new Promise((resolve) => {
          w.onmessage = (e) => resolve(e.data);
          w.onerror = (e) => resolve({ error: e.message || 'worker error' });
          w.postMessage({ id: 1, repo: 'Xenova/whisper-tiny', audio }, [audio.buffer]);
        });
        w.terminate();
        if (reply.error) throw new Error(reply.error);
        return reply.text;
      },
      { worker, speech },
    );
    console.log(`transcribed on device in ${Date.now() - started} ms: «${text}»`);
    if (!/train station/i.test(text)) throw new Error(`unexpected transcript: ${text}`);

    // The whole path in the interface: a voice message from a friend → «Расшифровать» → the model
    // is chosen in the consent dialog → the text appears under the voice message.
    const { createAccount } = await import('../../src/core/messenger.ts');
    const { MemoryStorage } = await import('../../src/core/storage.ts');
    const { port } = await page.evaluate(() => window.veil.server.status());
    const friend = await createAccount({
      storage: new MemoryStorage(),
      serverUrl: `127.0.0.1:${port}`,
      username: 'smoke_friend',
      displayName: 'Друг',
      password: 'friend-password',
      kdf: { N: 2 ** 10, r: 8, p: 1 },
    });
    for (let i = 0; friend.getSnapshot().status !== 'online' && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
    const contact = await friend.addContact('smoke_test');
    const wave = Array.from({ length: 40 }, (_, i) => 6 + ((i * 5) % 20));
    await friend.sendMedia(contact.id, [{ name: 'voice.ogg', mime: 'audio/ogg', data: new Uint8Array(readFileSync(join('tests', 'fixtures', 'speech-en.ogg'))), kind: 'voice', dur: 4, wave }]);
    await page.getByTestId('chat-smoke_friend').click();
    await page.getByRole('button', { name: 'Расшифровать голосовое' }).click();
    const dialog = page.getByTestId('model-dialog');
    await dialog.getByText(/^Быстрая/).click();
    await dialog.getByRole('button', { name: 'Использовать' }).click();
    const shown = page.getByTestId('voice-text');
    await shown.getByText(/train station/i).waitFor({ timeout: 120_000 });
    await shown.getByText('Текст: на устройстве').waitFor();
    if (process.argv[5]) await page.screenshot({ path: process.argv[5] });
    friend.dispose();
    step('voice message transcribed in the chat ok');
  }

  // A veil:// link opened by the system while Veil runs (a second copy is started with it).
  const link = `veil://add/smoke_friend?k=${'A'.repeat(43)}`;
  await app.evaluate(({ app: a }, url) => a.emit('second-instance', {}, ['veil', url], {}), link);
  await page.getByTestId('open-invite').getByText('@smoke_friend').waitFor({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  step('veil:// link ok');

  const maximized = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isMaximized()));
  console.log('maximized on first launch:', maximized);
  if (process.argv[2]) {
    await page.waitForTimeout(800);
    await page.screenshot({ path: process.argv[2] });
  }
  step('smoke test passed');
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
