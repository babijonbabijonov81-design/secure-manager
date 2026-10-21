import { expect, test } from '@playwright/test';
import { createAccount } from '../../src/core/messenger.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { register, SERVER, shot } from './helpers.ts';

// The recipient's side of a link preview: the card comes inside the message, Veil does not open the link.
test('a link preview made by the sender', async ({ browser }) => {
  const suffix = Date.now().toString(36);
  const bob = await register(browser, 'pvbob', 'Борис', suffix);
  const alice = await createAccount({
    storage: new MemoryStorage(),
    serverUrl: SERVER,
    username: `pvalice_${suffix}`,
    displayName: 'Алиса',
    password: 'alice-password',
    kdf: { N: 2 ** 10, r: 8, p: 1 },
  });
  await expect.poll(() => alice.getSnapshot().status, { timeout: 15_000 }).toBe('online');
  const contact = await alice.addContact(bob.username);
  await alice.sendText(contact.id, 'Смотри, что нашла: https://example.org/forest-trip', {
    preview: { url: 'https://example.org/forest-trip', title: 'Поход по Карелии за 5 дней', desc: 'Маршрут, снаряжение и где ночевать', site: 'example.org' },
  });

  const page = bob.page;
  await page.getByText('Алиса').first().click();
  const card = page.getByTestId('link-preview');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Поход по Карелии за 5 дней');
  await expect(card).toContainText('Маршрут, снаряжение и где ночевать');
  await expect(card).toContainText('Превью сделал отправитель');
  await shot(page, 'link-preview');
  alice.dispose();
});
