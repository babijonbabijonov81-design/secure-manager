import { describe, expect, it } from 'vitest';
import { safetyNumber } from '../src/core/crypto/fingerprint.ts';
import { generateDH, random } from '../src/core/crypto/primitives.ts';
import { ratchetDecrypt, ratchetEncrypt, initInitiator, initResponder } from '../src/core/crypto/ratchet.ts';
import { openEnvelope, padmeLength, sealEnvelope } from '../src/core/crypto/sealed.ts';
import {
  createInitiatorSession,
  createResponderSession,
  ephemeralDecrypt,
  ephemeralEncrypt,
  parseWire,
  sessionDecrypt,
  sessionEncrypt,
  type SessionRecord,
} from '../src/core/crypto/session.ts';
import { createVault, decryptRecord, encryptRecord, unlockVault, changeVaultPassword, WrongPasswordError } from '../src/core/crypto/vault.ts';
import { generateIdentity, signPreKey, x3dhInitiate, x3dhRespond, type IdentityKeys, type RemoteBundle } from '../src/core/crypto/x3dh.ts';
import { b64, fromUtf8, utf8 } from '../server/src/shared/wire.ts';

function makeUser(withOpk = true) {
  const identity = generateIdentity();
  const spk = generateDH();
  const opk = generateDH();
  const bundle: RemoteBundle = {
    signPub: identity.sign.pub,
    dhPub: identity.dh.pub,
    dhSig: identity.dhSig,
    spkId: 7,
    spkPub: spk.pub,
    spkSig: signPreKey(identity.sign.priv, 7, spk.pub),
    ...(withOpk ? { opkId: 3, opkPub: opk.pub } : {}),
  };
  return { identity, spk, opk, bundle };
}

const pub = (id: IdentityKeys) => ({ signPub: id.sign.pub, dhPub: id.dh.pub });

function handshake(withOpk = true) {
  const alice = makeUser();
  const bob = makeUser(withOpk);
  const a: SessionRecord = createInitiatorSession(alice.identity, bob.bundle);
  return { alice, bob, a };
}

describe('X3DH', () => {
  it('derives the same secret on both sides, with and without a one-time prekey', () => {
    for (const withOpk of [true, false]) {
      const alice = makeUser();
      const bob = makeUser(withOpk);
      const init = x3dhInitiate(alice.identity, bob.bundle);
      const resp = x3dhRespond(bob.identity, bob.spk, withOpk ? bob.opk : null, pub(alice.identity), init.ephemeral.pub);
      expect(b64(init.sk)).toBe(b64(resp.sk));
      expect(b64(init.ad)).toBe(b64(resp.ad));
    }
  });

  it('rejects bundles whose keys are not signed by the identity', () => {
    const alice = makeUser();
    const bob = makeUser();
    const mallory = makeUser();
    expect(() => x3dhInitiate(alice.identity, { ...bob.bundle, spkPub: mallory.spk.pub })).toThrow(/signed prekey/);
    expect(() => x3dhInitiate(alice.identity, { ...bob.bundle, dhPub: mallory.identity.dh.pub })).toThrow(/identity key/);
  });
});

describe('Double Ratchet', () => {
  function pair() {
    const sk = random(32);
    const bobSpk = generateDH();
    const ad = random(64);
    return { a: initInitiator(sk, bobSpk.pub), b: initResponder(sk, bobSpk), ad };
  }

  it('exchanges messages in both directions', () => {
    let { a, b, ad } = pair();
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 3; i++) {
        const enc = ratchetEncrypt(a, utf8(`a${round}.${i}`), ad);
        a = enc.state;
        const dec = ratchetDecrypt(b, enc.message, ad);
        b = dec.state;
        expect(fromUtf8(dec.plaintext)).toBe(`a${round}.${i}`);
      }
      const enc = ratchetEncrypt(b, utf8(`b${round}`), ad);
      b = enc.state;
      const dec = ratchetDecrypt(a, enc.message, ad);
      a = dec.state;
      expect(fromUtf8(dec.plaintext)).toBe(`b${round}`);
    }
  });

  it('handles out-of-order and delayed messages across ratchet steps', () => {
    let { a, b, ad } = pair();
    const sent = [];
    for (let i = 0; i < 4; i++) {
      const enc = ratchetEncrypt(a, utf8(`m${i}`), ad);
      a = enc.state;
      sent.push(enc.message);
    }
    // Bob receives m3 first, then replies, then gets the delayed ones.
    let dec = ratchetDecrypt(b, sent[3], ad);
    b = dec.state;
    expect(fromUtf8(dec.plaintext)).toBe('m3');
    const reply = ratchetEncrypt(b, utf8('reply'), ad);
    b = reply.state;
    a = ratchetDecrypt(a, reply.message, ad).state;
    const next = ratchetEncrypt(a, utf8('after'), ad);
    a = next.state;
    dec = ratchetDecrypt(b, next.message, ad);
    b = dec.state;
    expect(fromUtf8(dec.plaintext)).toBe('after');
    for (const i of [1, 0, 2]) {
      dec = ratchetDecrypt(b, sent[i], ad);
      b = dec.state;
      expect(fromUtf8(dec.plaintext)).toBe(`m${i}`);
    }
    expect(b.skipped).toHaveLength(0);
  });

  it('rejects replays and tampering without corrupting state', () => {
    let { a, b, ad } = pair();
    const enc = ratchetEncrypt(a, utf8('hello'), ad);
    a = enc.state;
    const tampered = { ...enc.message, ct: enc.message.ct.slice() };
    tampered.ct[0] ^= 1;
    expect(() => ratchetDecrypt(b, tampered, ad)).toThrow();
    expect(() => ratchetDecrypt(b, enc.message, random(64))).toThrow();
    const ok = ratchetDecrypt(b, enc.message, ad);
    expect(fromUtf8(ok.plaintext)).toBe('hello');
    expect(() => ratchetDecrypt(ok.state, enc.message, ad)).toThrow();
  });

  it('provides forward secrecy: old message keys are gone after use', () => {
    const { a, b, ad } = pair();
    const enc = ratchetEncrypt(a, utf8('secret'), ad);
    const after = ratchetDecrypt(b, enc.message, ad).state;
    // A snapshot of Bob's state taken after reading cannot decrypt the message again.
    expect(() => ratchetDecrypt(structuredClone(after), enc.message, ad)).toThrow();
  });

  it('refuses to skip more than the limit', () => {
    let { a, b, ad } = pair();
    let last;
    for (let i = 0; i < 1002; i++) {
      last = ratchetEncrypt(a, utf8('x'), ad);
      a = last.state;
    }
    expect(() => ratchetDecrypt(b, last!.message, ad)).toThrow(/too many skipped/);
  });
});

describe('Sessions', () => {
  it('sends X3DH headers until the peer replies, then switches to normal messages', () => {
    const h = handshake();
    const first = sessionEncrypt(h.a, utf8('one'));
    h.a = first.session;
    const second = sessionEncrypt(h.a, utf8('two'));
    h.a = second.session;
    const w1 = parseWire(first.wire);
    const w2 = parseWire(second.wire);
    expect(w1.header.k).toBe('pre');
    expect(w2.header.k).toBe('pre');
    expect(w2.header.x).toEqual(w1.header.x);

    // Bob only receives the second message first.
    let b = createResponderSession(h.bob.identity, h.bob.spk, h.bob.opk, pub(h.alice.identity), w2.header.x!);
    let dec = sessionDecrypt(b, w2.header, w2.body);
    b = dec.session;
    expect(fromUtf8(dec.plaintext)).toBe('two');
    dec = sessionDecrypt(b, w1.header, w1.body);
    b = dec.session;
    expect(fromUtf8(dec.plaintext)).toBe('one');

    const reply = sessionEncrypt(b, utf8('hi alice'));
    const wr = parseWire(reply.wire);
    expect(wr.header.k).toBe('msg');
    const back = sessionDecrypt(h.a, wr.header, wr.body);
    expect(fromUtf8(back.plaintext)).toBe('hi alice');
    expect(back.session.pending).toBeUndefined();
    const after = parseWire(sessionEncrypt(back.session, utf8('x')).wire);
    expect(after.header.k).toBe('msg');
  });

  it('encrypts ephemeral signals with the session key without touching the ratchet', () => {
    const h = handshake(false);
    const w = parseWire(sessionEncrypt(h.a, utf8('hello')).wire);
    const b = createResponderSession(h.bob.identity, h.bob.spk, null, pub(h.alice.identity), w.header.x!);
    const signal = parseWire(ephemeralEncrypt(h.a, utf8('typing')));
    expect(signal.header.k).toBe('eph');
    expect(fromUtf8(ephemeralDecrypt(b, signal.header, signal.body))).toBe('typing');
    const stranger = makeUser();
    const wrong = createResponderSession(h.bob.identity, h.bob.spk, null, pub(stranger.identity), w.header.x!);
    expect(() => ephemeralDecrypt(wrong, signal.header, signal.body)).toThrow();
  });

  it('a responder with the wrong identity for the sender cannot decrypt (no impersonation)', () => {
    const h = handshake();
    const w = parseWire(sessionEncrypt(h.a, utf8('hello')).wire);
    const mallory = makeUser();
    const b = createResponderSession(h.bob.identity, h.bob.spk, h.bob.opk, pub(mallory.identity), w.header.x!);
    expect(() => sessionDecrypt(b, w.header, w.body)).toThrow();
  });
});

describe('Sealed sender envelopes', () => {
  const sender = (u: ReturnType<typeof makeUser>) => ({
    from: b64(u.identity.sign.pub),
    fd: b64(u.identity.dh.pub),
    fs: b64(u.identity.dhSig),
  });

  it('round-trips and hides the payload length in padding buckets', () => {
    const alice = makeUser();
    const bob = makeUser();
    const wire = random(1000);
    const env = sealEnvelope(bob.identity.dh.pub, sender(alice), wire);
    const opened = openEnvelope(bob.identity.dh, env);
    expect(opened.sender.from).toBe(b64(alice.identity.sign.pub));
    expect(b64(opened.wire)).toBe(b64(wire));
    const sizeA = sealEnvelope(bob.identity.dh.pub, sender(alice), random(1001)).length;
    const sizeB = sealEnvelope(bob.identity.dh.pub, sender(alice), random(1010)).length;
    expect(sizeA).toBe(sizeB);
  });

  it('cannot be opened by anyone else or modified', () => {
    const alice = makeUser();
    const bob = makeUser();
    const eve = makeUser();
    const env = sealEnvelope(bob.identity.dh.pub, sender(alice), utf8('hi'));
    expect(() => openEnvelope(eve.identity.dh, env)).toThrow();
    const tampered = env.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(() => openEnvelope(bob.identity.dh, tampered)).toThrow();
  });

  it('rejects sender keys that are not bound to the sender identity', () => {
    const alice = makeUser();
    const bob = makeUser();
    const eve = makeUser();
    const forged = { ...sender(alice), fd: b64(eve.identity.dh.pub) };
    const env = sealEnvelope(bob.identity.dh.pub, forged, utf8('hi'));
    expect(() => openEnvelope(bob.identity.dh, env)).toThrow(/invalid sender/);
  });

  it('Padmé lengths never shrink and stay within ~12% overhead', () => {
    for (let n = 1; n < 200000; n += 997) {
      const p = padmeLength(n);
      expect(p).toBeGreaterThanOrEqual(n);
      if (n > 256) expect(p / n).toBeLessThan(1.13);
    }
  });
});

describe('Safety numbers', () => {
  it('are identical for both people and differ between pairs', () => {
    const a = b64(makeUser().identity.sign.pub);
    const b = b64(makeUser().identity.sign.pub);
    const c = b64(makeUser().identity.sign.pub);
    expect(safetyNumber(a, b)).toBe(safetyNumber(b, a));
    expect(safetyNumber(a, b)).toMatch(/^\d{60}$/);
    expect(safetyNumber(a, b)).not.toBe(safetyNumber(a, c));
  });
});

describe('Vault', () => {
  const fast = { N: 2 ** 10, r: 8, p: 1 };

  it('unlocks only with the right password and binds records to their names', async () => {
    const { meta, dataKey } = await createVault('correct horse', fast);
    await expect(unlockVault(meta, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
    const key = await unlockVault(meta, 'correct horse');
    expect(b64(key)).toBe(b64(dataKey));
    const rec = encryptRecord(key, 'contacts', utf8('{"a":1}'));
    expect(fromUtf8(decryptRecord(key, 'contacts', rec))).toBe('{"a":1}');
    expect(() => decryptRecord(key, 'account', rec)).toThrow();
  });

  it('changes the password without re-encrypting data', async () => {
    const { meta, dataKey } = await createVault('old', fast);
    const next = await changeVaultPassword(meta, 'old', 'new');
    expect(b64(await unlockVault(next, 'new'))).toBe(b64(dataKey));
    await expect(unlockVault(next, 'old')).rejects.toBeInstanceOf(WrongPasswordError);
  });
});
