// «Слова-сверка»: two words both people see during a call, derived from the DTLS certificate
// fingerprints of both sides. The fingerprints travel inside the end-to-end encrypted call offer
// and answer, and the call is encrypted with keys checked against them. Someone in the middle
// would have to put their own certificates in, and then each side would see different words.

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from '../../server/src/shared/wire.ts';
import { WORDS_RU } from './words-ru.ts';

/** "sha-256 AB:CD:…" from an SDP (the first fingerprint line), upper-case, or null. */
export function sdpFingerprint(sdp: string | undefined | null): string | null {
  const match = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/m.exec(sdp ?? '');
  return match ? `${match[1].toLowerCase()} ${match[2].toUpperCase()}` : null;
}

/** The same two words on both sides: the fingerprints are sorted before hashing. */
export function callWords(local: string, remote: string): [string, string] {
  const [a, b] = [local, remote].sort();
  const hash = sha256(utf8(`veil-call-words-v1|${a}|${b}`));
  const bits = (hash[0] << 16) | (hash[1] << 8) | hash[2];
  return [WORDS_RU[(bits >>> 13) & 2047], WORDS_RU[(bits >>> 2) & 2047]];
}
