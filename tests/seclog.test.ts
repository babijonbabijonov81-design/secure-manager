import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unlock } from '../src/core/messenger.ts';
import { makeUser, testRelay, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

describe('security log (P1-8)', () => {
  it('records sign-ins, failed attempts and password changes, encrypted on disk', async () => {
    const alice = await makeUser(t.url, 'alice');
    alice.messenger.recordLogin('pin', 2);
    await alice.messenger.changePassword(alice.password, 'brand-new-password');
    await alice.messenger.enableDuress('panic-password-9', { wipe: false });
    const kinds = alice.messenger.getSnapshot().securityLog.map((e) => e.kind);
    expect(kinds).toEqual(['duress_on', 'password_change', 'login', 'login_failed']);
    expect(alice.messenger.getSnapshot().securityLog.find((e) => e.kind === 'login_failed')?.detail).toBe('2');
    await alice.messenger.lock();
    for (const key of await alice.storage.list()) {
      const raw = Buffer.from((await alice.storage.get(key))!);
      expect(raw.includes(Buffer.from('password_change'))).toBe(false);
    }
    const again = await unlock(alice.storage, 'brand-new-password');
    expect(again.getSnapshot().securityLog.map((e) => e.kind)).toContain('password_change');
    // The empty Veil behind the duress password keeps no log.
    await again.lock();
    const decoy = await unlock(alice.storage, 'panic-password-9');
    decoy.recordLogin('password');
    expect(decoy.getSnapshot().securityLog).toEqual([]);
    await decoy.lock();
  });

  it('switching the feature off stops logging', async () => {
    const bob = await makeUser(t.url, 'bob');
    bob.messenger.updateSettings({ features: { ...bob.messenger.getSnapshot().settings.features, securityLog: false } });
    bob.messenger.recordLogin('password');
    expect(bob.messenger.getSnapshot().securityLog).toEqual([]);
    bob.messenger.dispose();
  });
});
