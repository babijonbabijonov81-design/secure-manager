// Sender Keys for groups — the scheme Signal and WhatsApp use, on top of Veil's pairwise sessions.
//
// Every member keeps a chain for each group: a chain key CK and an Ed25519 signing key pair.
//   message key  MK_n   = HMAC-SHA256(CK_n, 0x01)
//   next chain   CK_n+1 = HMAC-SHA256(CK_n, 0x02)
//   ciphertext   XChaCha20-Poly1305(MK_n, plaintext, AD = "veil-group-v1|group|sender|chain|n")
//   signature    Ed25519(AD ‖ nonce ‖ ciphertext) by the chain's signing key
// The chain key and the public signing key reach each member once, inside the pairwise Double
// Ratchet session ("sender key distribution"), so only members can read, and the signature means
// one member cannot write in another's name even though they all hold the same chain key.
// Message keys are used once and dropped; after someone leaves, everyone starts a new chain.

import { b64, concat, randomId, unb64Len, utf8 } from '../../../server/src/shared/wire.ts';
import { aeadOpen, aeadSeal, generateSigning, mac, random, sign, verify } from './primitives.ts';

export interface SenderChain {
  /** Chain id: a new one after every rotation. */
  id: string;
  /** Index of the next message key. */
  n: number;
  ck: string;
  /** Public signing key; `ss` (private) only in my own chain. */
  sp: string;
  ss?: string;
  /** Keys of messages skipped over (arrived out of order), by index. */
  skipped?: Record<string, string>;
}

/** What a member sends privately to every other member. */
export interface SenderKeyDistribution {
  cid: string;
  n: number;
  ck: string;
  sp: string;
}

export interface GroupWire {
  cid: string;
  n: number;
  nonce: string;
  sig: string;
}

const MAX_SKIP = 2000;
const MAX_SKIPPED_KEPT = 200;

export function newSenderChain(): SenderChain {
  const signing = generateSigning();
  return { id: randomId(8), n: 0, ck: b64(random(32)), sp: b64(signing.pub), ss: b64(signing.priv) };
}

export const distributionOf = (chain: SenderChain): SenderKeyDistribution => ({ cid: chain.id, n: chain.n, ck: chain.ck, sp: chain.sp });

/** A distribution received from another member; null if malformed. */
export function chainFrom(d: Partial<SenderKeyDistribution>): SenderChain | null {
  if (typeof d.cid !== 'string' || !/^[\w-]{6,32}$/.test(d.cid) || !Number.isInteger(d.n) || d.n! < 0) return null;
  if (!unb64Len(d.ck, 32) || !unb64Len(d.sp, 32)) return null;
  return { id: d.cid, n: d.n!, ck: d.ck!, sp: d.sp! };
}

const step = (ck: Uint8Array) => ({ mk: mac(ck, Uint8Array.of(1)), next: mac(ck, Uint8Array.of(2)) });

export const groupAd = (groupId: string, senderId: string, chainId: string, n: number) => utf8(`veil-group-v1|${groupId}|${senderId}|${chainId}|${n}`);

export function senderEncrypt(chain: SenderChain, plaintext: Uint8Array, groupId: string, senderId: string): { chain: SenderChain; wire: GroupWire; ct: Uint8Array } {
  const signing = unb64Len(chain.ss, 32);
  if (!signing) throw new Error('SenderKeys: not my chain');
  const { mk, next } = step(unb64Len(chain.ck, 32)!);
  const ad = groupAd(groupId, senderId, chain.id, chain.n);
  const { nonce, ct } = aeadSeal(mk, plaintext, ad);
  const sig = sign(concat(ad, nonce, ct), signing);
  return { chain: { ...chain, n: chain.n + 1, ck: b64(next) }, wire: { cid: chain.id, n: chain.n, nonce: b64(nonce), sig: b64(sig) }, ct };
}

/** Throws on a bad signature, a tampered ciphertext, a replay or too large a gap. */
export function senderDecrypt(chain: SenderChain, wire: GroupWire, ct: Uint8Array, groupId: string, senderId: string): { chain: SenderChain; plaintext: Uint8Array } {
  const nonce = unb64Len(wire.nonce, 24);
  const sig = unb64Len(wire.sig, 64);
  if (wire.cid !== chain.id || !Number.isInteger(wire.n) || wire.n < 0 || !nonce || !sig) throw new Error('SenderKeys: bad message');
  const ad = groupAd(groupId, senderId, chain.id, wire.n);
  if (!verify(sig, concat(ad, nonce, ct), unb64Len(chain.sp, 32)!)) throw new Error('SenderKeys: bad signature');

  const skipped = { ...chain.skipped };
  let mk: Uint8Array;
  let ck = unb64Len(chain.ck, 32)!;
  let n = chain.n;
  if (wire.n < n) {
    const kept = skipped[wire.n];
    if (!kept) throw new Error('SenderKeys: replayed or too old');
    mk = unb64Len(kept, 32)!;
    delete skipped[wire.n];
  } else {
    if (wire.n - n > MAX_SKIP) throw new Error('SenderKeys: too many skipped messages');
    while (n < wire.n) {
      const s = step(ck);
      skipped[n] = b64(s.mk);
      ck = s.next;
      n++;
    }
    const s = step(ck);
    mk = s.mk;
    ck = s.next;
    n++;
  }
  const plaintext = aeadOpen(mk, nonce, ct, ad);
  const keys = Object.keys(skipped).map(Number).sort((a, b) => a - b);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SKIPPED_KEPT))) delete skipped[old];
  return { chain: { ...chain, n, ck: b64(ck), ...(Object.keys(skipped).length ? { skipped } : { skipped: undefined }) }, plaintext };
}
