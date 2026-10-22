import { expect, test } from '@playwright/test';
import { openChat, register, send, shot } from './helpers.ts';

// Группы: create, talk among three, the group shield, remove a member, leave.
test('group chat with roles, shield and member removal', async ({ browser }) => {
  test.setTimeout(150_000);
  const suffix = Date.now().toString(36);
  const alice = await register(browser, 'gralice', 'Алиса', suffix);
  const bob = await register(browser, 'grbob', 'Борис', suffix);
  const vera = await register(browser, 'grvera', 'Вера', suffix);
  // Alice knows both; Bob and Vera do not know each other.
  for (const other of [bob, vera]) {
    await openChat(alice.page, other.username);
    await expect(alice.page.locator('.chat-header')).toContainText(other.username);
    await send(alice.page, 'Привет!');
    await expect(alice.page.locator('.messages').getByText('Привет!')).toBeVisible();
  }

  await alice.page.getByRole('button', { name: 'Новый чат' }).first().click();
  await alice.page.getByRole('button', { name: 'Новая группа' }).click();
  const create = alice.page.getByTestId('group-create');
  await create.getByLabel('Название группы').fill('Дача на выходных');
  await create.getByText(`@${bob.username}`).click();
  await create.getByText(`@${vera.username}`).click();
  await create.getByRole('button', { name: /Создать группу · 3 участника/ }).click();
  await expect(alice.page.locator('.chat-header')).toContainText('3 участника');
  await send(alice.page, 'Кто что везёт?');

  // Bob sees the group and Alice's message with her name; Vera is not in his chat list.
  await bob.page.getByRole('listitem').filter({ hasText: 'Дача на выходных' }).click();
  await expect(bob.page.locator('.messages').getByText('Кто что везёт?')).toBeVisible();
  await expect(bob.page.locator('.sender-name').first()).toHaveText('Алиса');
  await expect(bob.page.locator('.chat-list').getByRole('listitem').filter({ hasText: vera.username })).toHaveCount(0);
  await send(bob.page, 'Я — мангал');
  await vera.page.getByRole('listitem').filter({ hasText: 'Дача на выходных' }).click();
  await expect(vera.page.locator('.messages').getByText('Я — мангал')).toBeVisible();
  await expect(alice.page.locator('.messages').getByText('Я — мангал')).toBeVisible();

  // The group shield: verified keys out of the members.
  await expect(alice.page.getByTestId('shield-badge')).toContainText('/4');
  // Wide windows show the shield next to the chat already.
  if ((await alice.page.getByTestId('shield-badge').getAttribute('aria-expanded')) !== 'true') await alice.page.getByTestId('shield-badge').click();
  await expect(alice.page.getByTestId('shield-code')).toContainText('Сверены у 0 из 2');
  const members = alice.page.getByTestId('group-members');
  await expect(members.getByText('Владелец')).toBeVisible();
  await shot(alice.page, 'group');

  // Alice removes Vera: Vera's group goes read-only, she gets nothing new.
  await members.getByRole('button', { name: new RegExp(`^${vera.username}, участник`) }).click();
  await alice.page.locator('.context-menu').getByText('Удалить из группы').click();
  await alice.page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(alice.page.locator('.chat-header')).toContainText('2 участника');
  await expect(vera.page.getByText('Вы больше не участник этой группы')).toBeVisible();
  await send(alice.page, 'Без Веры');
  await expect(bob.page.locator('.messages').getByText('Без Веры')).toBeVisible();
  await vera.page.waitForTimeout(800);
  await expect(vera.page.locator('.messages').getByText('Без Веры')).toHaveCount(0);
});
