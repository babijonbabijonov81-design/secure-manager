import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lastText, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

const pair = async () => {
  const alice = await makeUser(t.url, 'alice');
  const bob = await makeUser(t.url, 'bob');
  await alice.messenger.addContact(bob.username);
  await alice.messenger.sendText(bob.id, 'Привет');
  await waitFor(() => lastText(bob.messenger, alice.id) === 'Привет');
  await bob.messenger.sendText(alice.id, 'Привет!');
  await waitFor(() => lastText(alice.messenger, bob.id) === 'Привет!');
  return { alice, bob };
};

describe('hiding presence with reciprocity (P1-6)', () => {
  it('«прочитано»: who hides theirs does not see others', async () => {
    const { alice, bob } = await pair();
    alice.messenger.updateSettings({ readReceipts: false });
    await alice.messenger.sendText(bob.id, 'Прочитаешь?');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'Прочитаешь?');
    bob.messenger.markRead(alice.id); // Bob shares receipts, but Alice hides hers
    await waitFor(() => messages(alice.messenger, bob.id).at(-1)?.status === 'delivered');
    await new Promise((r) => setTimeout(r, 400));
    expect(messages(alice.messenger, bob.id).at(-1)?.status).toBe('delivered');

    await bob.messenger.sendText(alice.id, 'А ты?');
    await waitFor(() => lastText(alice.messenger, bob.id) === 'А ты?');
    alice.messenger.markRead(bob.id);
    await new Promise((r) => setTimeout(r, 400));
    expect(messages(bob.messenger, alice.id).at(-1)?.status).toBe('delivered');
    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('per contact: «печатает» hidden from one person only, both ways', async () => {
    const { alice, bob } = await pair();
    const carol = await makeUser(t.url, 'carol');
    await alice.messenger.addContact(carol.username);
    await alice.messenger.sendText(carol.id, 'Привет, Кэрол');
    await waitFor(() => lastText(carol.messenger, alice.id) === 'Привет, Кэрол');
    await carol.messenger.sendText(alice.id, 'Привет');
    await waitFor(() => lastText(alice.messenger, carol.id) === 'Привет');

    alice.messenger.setContactPrivacy(bob.id, { typing: false });
    alice.messenger.sendTyping(bob.id, true);
    alice.messenger.sendTyping(carol.id, true);
    await waitFor(() => carol.messenger.getSnapshot().typing[alice.id]);
    await new Promise((r) => setTimeout(r, 300));
    expect(bob.messenger.getSnapshot().typing[alice.id]).toBeFalsy();
    bob.messenger.sendTyping(alice.id, true);
    await new Promise((r) => setTimeout(r, 400));
    expect(alice.messenger.getSnapshot().typing[bob.id]).toBeFalsy();

    alice.messenger.setContactPrivacy(bob.id, { typing: undefined });
    expect(alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.privacy).toBeUndefined();
    for (const u of [alice, bob, carol]) u.messenger.dispose();
  });

  it('«в сети» hidden from one contact: they see «был(а) недавно», and I do not see them', async () => {
    const { alice, bob } = await pair();
    await waitFor(() => alice.messenger.getSnapshot().online[bob.id]);
    alice.messenger.setContactPrivacy(bob.id, { online: false });
    await waitFor(() => bob.messenger.getSnapshot().contacts.find((c) => c.id === alice.id)?.presenceHidden);
    expect(alice.messenger.getSnapshot().online[bob.id]).toBeFalsy();
    await bob.messenger.sendText(alice.id, 'Я тут');
    await waitFor(() => lastText(alice.messenger, bob.id) === 'Я тут');
    expect(alice.messenger.getSnapshot().online[bob.id]).toBeFalsy();
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
