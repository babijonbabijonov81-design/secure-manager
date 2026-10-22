// Группы: Sender Keys, the rules for changes, and «the server sees only ciphertext».
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { b64 } from '../server/src/shared/wire.ts';
import { generateIdentity } from '../src/core/crypto/x3dh.ts';
import { chainFrom, distributionOf, newSenderChain, senderDecrypt, senderEncrypt } from '../src/core/crypto/sender-keys.ts';
import { canApply, groupChatId, validState, withoutMember, type GroupMember, type GroupRole, type GroupState } from '../src/core/groups.ts';
import type { Messenger } from '../src/core/messenger.ts';
import { utf8, fromUtf8 } from '../server/src/shared/wire.ts';
import { expectOnlyCiphertext, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

describe('sender keys', () => {
  it('encrypt once, every holder of the chain decrypts, in or out of order', () => {
    let mine = newSenderChain();
    let theirs = chainFrom(distributionOf(mine))!;
    const sent = ['раз', 'два', 'три'].map((text) => {
      const out = senderEncrypt(mine, utf8(text), 'grp1', 'alice');
      mine = out.chain;
      return out;
    });
    // «три» first, then «раз», then «два»: skipped keys are kept.
    for (const i of [2, 0, 1]) {
      const { chain, plaintext } = senderDecrypt(theirs, sent[i].wire, sent[i].ct, 'grp1', 'alice');
      theirs = chain;
      expect(fromUtf8(plaintext)).toBe(['раз', 'два', 'три'][i]);
    }
    // A replay fails: the key is gone.
    expect(() => senderDecrypt(theirs, sent[0].wire, sent[0].ct, 'grp1', 'alice')).toThrow(/replayed/);
  });

  it('a member cannot write in another member’s name, nor move a message to another group', () => {
    const alice = newSenderChain();
    const shared = chainFrom(distributionOf(alice))!;
    const { wire, ct } = senderEncrypt(alice, utf8('привет'), 'grp1', 'alice');
    // Mallory holds the chain key but not Alice's signing key.
    const forged = senderEncrypt({ ...shared, ss: newSenderChain().ss }, utf8('я Алиса'), 'grp1', 'alice');
    expect(() => senderDecrypt(shared, forged.wire, forged.ct, 'grp1', 'alice')).toThrow(/signature/);
    expect(() => senderDecrypt(shared, wire, ct, 'grp2', 'alice')).toThrow(/signature/);
    expect(() => senderDecrypt(shared, wire, ct, 'grp1', 'bob')).toThrow(/signature/);
    const flipped = ct.slice();
    flipped[0] ^= 1;
    expect(() => senderDecrypt(shared, wire, flipped, 'grp1', 'alice')).toThrow();
  });
});

describe('group rules', () => {
  const person = (role: GroupRole): GroupMember => {
    const id = generateIdentity();
    return { id: b64(id.sign.pub), username: `u${Math.random().toString(36).slice(2, 9)}`, name: 'Имя', role, dh: b64(id.dh.pub), ds: b64(id.dhSig) };
  };
  const owner = person('owner');
  const admin = person('admin');
  const member = person('member');
  const state: GroupState = { id: 'group-0001', name: 'Дача', v: 3, members: [owner, admin, member] };
  const next = (patch: Partial<GroupState>) => ({ ...state, v: 4, ...patch });

  it('checks the keys and the single owner', () => {
    expect(validState(state)).toBe(true);
    expect(validState({ ...state, members: [owner, { ...admin, role: 'owner' }] })).toBe(false);
    expect(validState({ ...state, members: [{ ...member, ds: owner.ds }] })).toBe(false);
  });

  it('owner may do anything, admin only ordinary members and the name, member nothing', () => {
    const newcomer = person('member');
    expect(canApply(state, next({ members: [...state.members, newcomer] }), admin.id, member.id)).toBe(true);
    expect(canApply(state, next({ name: 'Новое' }), admin.id, member.id)).toBe(true);
    expect(canApply(state, next({ members: [owner, admin] }), admin.id, member.id)).toBe(true);
    expect(canApply(state, next({ members: [owner, admin, { ...member, role: 'admin' }] }), admin.id, owner.id)).toBe(false);
    expect(canApply(state, next({ members: [owner, member] }), admin.id, member.id)).toBe(false);
    expect(canApply(state, next({ members: [...state.members, { ...newcomer, role: 'admin' }] }), admin.id, member.id)).toBe(false);
    expect(canApply(state, next({ name: 'Моё' }), member.id, owner.id)).toBe(false);
    expect(canApply(state, next({ members: [{ ...owner, role: 'admin' }, { ...admin, role: 'owner' }, member] }), owner.id, member.id)).toBe(true);
    // Old versions and someone outside the group are refused.
    expect(canApply(state, { ...state, name: 'Старое' }, owner.id, member.id)).toBe(false);
    expect(canApply(state, next({ name: 'x' }), newcomer.id, member.id)).toBe(false);
    // Being added: only by the owner or an admin, and only if I am in it.
    expect(canApply(undefined, state, member.id, owner.id)).toBe(false);
    expect(canApply(undefined, state, admin.id, newcomer.id)).toBe(false);
    expect(canApply(undefined, state, admin.id, member.id)).toBe(true);
  });

  it('when the owner leaves, the first admin owns the group', () => {
    const after = withoutMember(state, owner.id)!;
    expect(after.v).toBe(4);
    expect(after.members.find((m) => m.id === admin.id)?.role).toBe('owner');
    expect(state.members.find((m) => m.id === admin.id)?.role).toBe('admin');
  });
});

describe('group chats', () => {
  let t: TestRelay;
  beforeAll(async () => {
    t = await testRelay();
  });
  afterAll(async () => {
    await t.relay.close();
  });

  const chatOf = (m: Messenger, groupChat: string) => m.getSnapshot().contacts.find((c) => c.id === groupChat);
  const texts = (m: Messenger, chat: string) => messages(m, chat).filter((x) => x.dir !== 'system').map((x) => x.text);

  it('create, talk, add, remove, leave — the relay sees only ciphertext', async () => {
    const alice = await makeUser(t.url, 'alice', undefined, 'Алиса');
    const bob = await makeUser(t.url, 'bob', undefined, 'Борис');
    const carol = await makeUser(t.url, 'carol', undefined, 'Вера');
    const dan = await makeUser(t.url, 'dan', undefined, 'Денис');
    const cBob = await alice.messenger.addContact(bob.username);
    const cCarol = await alice.messenger.addContact(carol.username);
    const group = await alice.messenger.createGroup('Поездка на Байкал', [cBob.id, cCarol.id]);
    const gid = group.group!.id;
    const chat = groupChatId(gid);

    await waitFor(() => chatOf(bob.messenger, chat) && chatOf(carol.messenger, chat));
    expect(chatOf(bob.messenger, chat)?.group?.members.map((m) => m.role)).toEqual(['owner', 'member', 'member']);
    // Carol is not Bob's contact: she is known through the group only, not in his chat list.
    expect(bob.messenger.getSnapshot().contacts.find((c) => c.id === carol.id)?.groupOnly).toBe(true);

    await alice.messenger.sendText(chat, 'Билеты на поезд в среду');
    await waitFor(() => texts(bob.messenger, chat).includes('Билеты на поезд в среду') && texts(carol.messenger, chat).includes('Билеты на поезд в среду'));
    expect(messages(bob.messenger, chat).find((m) => m.text === 'Билеты на поезд в среду')?.from).toBe(alice.id);
    await bob.messenger.sendText(chat, 'Беру палатку');
    await waitFor(() => texts(alice.messenger, chat).includes('Беру палатку') && texts(carol.messenger, chat).includes('Беру палатку'));
    expect(messages(alice.messenger, chat).find((m) => m.text === 'Билеты на поезд в среду')?.status).toBe('sent');

    // Dan joins: he reads what comes after, not before.
    const cDan = await alice.messenger.addContact(dan.username);
    await alice.messenger.addGroupMembers(chat, [cDan.id]);
    await waitFor(() => chatOf(dan.messenger, chat));
    await waitFor(() => chatOf(carol.messenger, chat)?.group?.members.length === 4);
    await carol.messenger.sendText(chat, 'Денис, привет!');
    await waitFor(() => texts(dan.messenger, chat).includes('Денис, привет!'));
    expect(texts(dan.messenger, chat)).not.toContain('Билеты на поезд в среду');

    // Bob may not remove anyone; Alice removes Carol, who then gets nothing new.
    await expect(bob.messenger.removeGroupMember(chat, carol.id)).rejects.toMatchObject({ code: 'forbidden' });
    await alice.messenger.removeGroupMember(chat, carol.id);
    await waitFor(() => chatOf(carol.messenger, chat)?.group?.left);
    await waitFor(() => chatOf(bob.messenger, chat)?.group?.members.length === 3);
    await bob.messenger.sendText(chat, 'Без Веры');
    await waitFor(() => texts(alice.messenger, chat).includes('Без Веры') && texts(dan.messenger, chat).includes('Без Веры'));
    await new Promise((r) => setTimeout(r, 300));
    expect(texts(carol.messenger, chat)).not.toContain('Без Веры');

    // The owner leaves: Bob (first remaining) becomes the owner everywhere.
    await alice.messenger.leaveGroup(chat);
    await waitFor(() => chatOf(bob.messenger, chat)?.group?.members.length === 2 && chatOf(dan.messenger, chat)?.group?.members.length === 2);
    expect(chatOf(bob.messenger, chat)?.group?.members.find((m) => m.id === bob.id)?.role).toBe('owner');
    expect(chatOf(dan.messenger, chat)?.group?.members.find((m) => m.id === bob.id)?.role).toBe('owner');

    expectOnlyCiphertext(t.frames, ['Поездка на Байкал', 'Билеты на поезд', 'Беру палатку', 'Денис, привет', 'Без Веры', gid]);
    for (const u of [alice, bob, carol, dan]) u.messenger.dispose();
  });

  it('a member without the sender key asks for it and reads the message', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const cBob = await alice.messenger.addContact(bob.username);
    const group = await alice.messenger.createGroup('Работа', [cBob.id]);
    const chat = group.id;
    await waitFor(() => chatOf(bob.messenger, chat));
    await alice.messenger.sendText(chat, 'первое');
    await waitFor(() => texts(bob.messenger, chat).includes('первое'));
    // Bob loses Alice's chain (as after restoring a backup).
    (bob.messenger as unknown as { gkeys: Record<string, { peers: Record<string, unknown> }> }).gkeys[group.group!.id].peers = {};
    await alice.messenger.sendText(chat, 'второе');
    await new Promise((r) => setTimeout(r, 400));
    await alice.messenger.sendText(chat, 'третье');
    await waitFor(() => texts(bob.messenger, chat).includes('третье'));
    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('turned off: no groups are created and group messages are ignored', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const cBob = await alice.messenger.addContact(bob.username);
    bob.messenger.updateSettings({ features: { ...bob.messenger.getSnapshot().settings.features, groups: false } });
    await expect(bob.messenger.createGroup('x', [alice.id])).rejects.toMatchObject({ code: 'disabled' });
    const group = await alice.messenger.createGroup('Без Бориса', [cBob.id]);
    await alice.messenger.sendText(group.id, 'привет');
    await new Promise((r) => setTimeout(r, 500));
    expect(chatOf(bob.messenger, group.id)).toBeUndefined();
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
