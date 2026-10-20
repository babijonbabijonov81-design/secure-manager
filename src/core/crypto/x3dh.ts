// X3DH ("Extended Triple Diffie-Hellman") key agreement, as specified by Signal:
// https://signal.org/docs/specifications/x3dh/
//
// Each identity has an Ed25519 signing key (its public id) and an X25519 key used for
// Diffie-Hellman; the X25519 key, the signed prekey and its signature are all bound to
// the signing key, so a relay cannot substitute keys without breaking signatures.

import { dhKeyStatement, signedPreKeyStatement } from '../../../server/src/shared/protocol.ts';
import { concat } from '../../../server/src/shared/wire.ts';
import { dh, generateDH, generateSigning, kdf, sign, verify, wipe, type KeyPair } from './primitives.ts';

const INFO = 'Veil-X3DH-v1';
const F = new Uint8Array(32).fill(0xff);
const ZERO_SALT = new Uint8Array(32);

export interface IdentityKeys {
  sign: KeyPair;
  dh: KeyPair;
  dhSig: Uint8Array;
}

export interface PublicIdentity {
  signPub: Uint8Array;
  dhPub: Uint8Array;
}

export interface RemoteBundle extends PublicIdentity {
  dhSig: Uint8Array;
  spkId: number;
  spkPub: Uint8Array;
  spkSig: Uint8Array;
  opkId?: number;
  opkPub?: Uint8Array;
}

export interface X3DHResult {
  /** 32-byte shared secret that seeds the Double Ratchet. */
  sk: Uint8Array;
  /** Associated data binding both identities into every message. */
  ad: Uint8Array;
}

export interface InitiatorResult extends X3DHResult {
  ephemeral: KeyPair;
}

export const signDhKey = (signPriv: Uint8Array, dhPub: Uint8Array) => sign(dhKeyStatement(dhPub), signPriv);
export const verifyDhKey = (signPub: Uint8Array, dhPub: Uint8Array, sig: Uint8Array) =>
  verify(sig, dhKeyStatement(dhPub), signPub);
export const signPreKey = (signPriv: Uint8Array, id: number, pub: Uint8Array) =>
  sign(signedPreKeyStatement(id, pub), signPriv);
export const verifyPreKey = (signPub: Uint8Array, id: number, pub: Uint8Array, sig: Uint8Array) =>
  verify(sig, signedPreKeyStatement(id, pub), signPub);

export function generateIdentity(): IdentityKeys {
  const signKeys = generateSigning();
  const dhKeys = generateDH();
  return { sign: signKeys, dh: dhKeys, dhSig: signDhKey(signKeys.priv, dhKeys.pub) };
}

const associatedData = (initiator: PublicIdentity, responder: PublicIdentity) =>
  concat(initiator.signPub, initiator.dhPub, responder.signPub, responder.dhPub);

function deriveSecret(parts: Uint8Array[]): Uint8Array {
  const ikm = concat(F, ...parts);
  const sk = kdf(ikm, ZERO_SALT, INFO, 32);
  wipe(ikm, ...parts);
  return sk;
}

/** Alice's side: verify Bob's bundle and derive the shared secret. */
export function x3dhInitiate(me: IdentityKeys, bundle: RemoteBundle): InitiatorResult {
  if (!verifyDhKey(bundle.signPub, bundle.dhPub, bundle.dhSig)) throw new Error('X3DH: identity key signature is invalid');
  if (!verifyPreKey(bundle.signPub, bundle.spkId, bundle.spkPub, bundle.spkSig))
    throw new Error('X3DH: signed prekey signature is invalid');

  const ephemeral = generateDH();
  const parts = [
    dh(me.dh.priv, bundle.spkPub),
    dh(ephemeral.priv, bundle.dhPub),
    dh(ephemeral.priv, bundle.spkPub),
  ];
  if (bundle.opkPub) parts.push(dh(ephemeral.priv, bundle.opkPub));
  return {
    sk: deriveSecret(parts),
    ad: associatedData({ signPub: me.sign.pub, dhPub: me.dh.pub }, bundle),
    ephemeral,
  };
}

/** Bob's side: derive the same secret from Alice's first message. */
export function x3dhRespond(
  me: IdentityKeys,
  signedPreKey: KeyPair,
  oneTimePreKey: KeyPair | null,
  sender: PublicIdentity,
  ephemeralPub: Uint8Array,
): X3DHResult {
  const parts = [
    dh(signedPreKey.priv, sender.dhPub),
    dh(me.dh.priv, ephemeralPub),
    dh(signedPreKey.priv, ephemeralPub),
  ];
  if (oneTimePreKey) parts.push(dh(oneTimePreKey.priv, ephemeralPub));
  return {
    sk: deriveSecret(parts),
    ad: associatedData(sender, { signPub: me.sign.pub, dhPub: me.dh.pub }),
  };
}
