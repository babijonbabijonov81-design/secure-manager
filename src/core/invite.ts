// «Приглашение veil://»: a link (or its QR code) with the inviter's identity key inside.
//
//   veil://add/<username>?k=<identity key>&s=<server>&i=<server id>&sk=<server key>
//                         &a=<address>&a=<address>…&r=<registration token>&t=<one-time token>
//   (keys in base64url; links from older versions carry only k, s, i and t, and still work)
//
// `sk` is the server's own key: whoever opens the link talks only to a server that proves it,
// whichever address works for them. `a` lists the ways in (a tunnel through a public relay, an
// address opened on the router, the Wi-Fi address), so a link made on «localhost» works from
// another network too. `r` lets a newcomer register on an invite-only server.
//
// The identity key is the account id itself (the Ed25519 public key), so nothing new is
// computed: whoever opens the link compares the key the server returns with the one in the
// link, and a server that swapped keys is caught at once. Because the link is passed in person,
// the opener's side counts as verified («Сверен приглашением»).
//
// The token (16 random bytes, valid 7 days, one use) goes back to the inviter inside the first
// end-to-end encrypted message. Only the session with the inviter's real key can carry it, and
// only someone who had the link knows it, so the inviter's side is verified too.

import { USERNAME_RE } from '../../server/src/shared/protocol.ts';
import { b64, unb64 } from '../../server/src/shared/wire.ts';
import { random } from './crypto/primitives.ts';

export interface Invite {
  username: string;
  /** The inviter's identity key (account id), base64url like every key in Veil. */
  userId: string;
  /** The inviter's relay, as typed in their settings. */
  server?: string;
  /** The relay's stable id: the same server under another address (localhost / 192.168.…) still matches. */
  serverId?: string;
  /** The server's public key: the server is accepted only if it proves it. */
  serverKey?: string;
  /** Addresses of that server to try in order (tunnel, external, local network). */
  addresses?: string[];
  /** One-time registration token for an invite-only server. */
  registration?: string;
  token?: string;
}

export const INVITE_DAYS = 7;
export const MAX_INVITES = 20;

export const newInviteToken = () => b64(random(16));

/** The same relay written two ways ("wss://Host/" and "host") compares equal. */
export const serverKey = (url: string) =>
  url
    .trim()
    .toLowerCase()
    .replace(/^(wss?|https?):\/\//, '')
    .replace(/\/+$/, '');

/** localhost, 10.x, 172.16–31.x, 192.168.x, 169.254.x, *.local — an address only this Wi-Fi knows. */
export function isLanServer(url: string): boolean {
  const host = url.trim().replace(/^(wss?|https?):\/\//i, '').replace(/[:/].*$/, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export function inviteLink(invite: Invite): string {
  const query = new URLSearchParams({ k: invite.userId });
  if (invite.server) query.set('s', serverKey(invite.server));
  if (invite.serverId) query.set('i', invite.serverId);
  if (invite.serverKey) query.set('sk', invite.serverKey);
  for (const address of invite.addresses ?? []) query.append('a', address);
  if (invite.registration) query.set('r', invite.registration);
  if (invite.token) query.set('t', invite.token);
  return `veil://add/${encodeURIComponent(invite.username)}?${query.toString()}`;
}

/** Reads a veil:// link from anywhere in a text (a pasted message, a QR code, a command line). */
export function parseInvite(text: string): Invite | null {
  const raw = /veil:\/\/add\/[^\s<>"']+/i.exec(text)?.[0];
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const username = decodeURIComponent(url.pathname.replace(/^\//, '')).toLowerCase();
    const userId = url.searchParams.get('k') ?? '';
    if (!USERNAME_RE.test(username) || !/^[A-Za-z0-9_-]{43}$/.test(userId) || unb64(userId).length !== 32) return null;
    const server = url.searchParams.get('s') ?? undefined;
    const token = url.searchParams.get('t') ?? undefined;
    const serverId = url.searchParams.get('i') ?? undefined;
    const serverKey = url.searchParams.get('sk') ?? undefined;
    const registration = url.searchParams.get('r') ?? undefined;
    const addresses = url.searchParams
      .getAll('a')
      .filter((a) => a.length <= 300)
      .slice(0, 8);
    return {
      username,
      userId,
      ...(server && server.length <= 200 ? { server } : {}),
      ...(serverId && /^[A-Za-z0-9_-]{16}$/.test(serverId) ? { serverId } : {}),
      ...(serverKey && /^[A-Za-z0-9_-]{43}$/.test(serverKey) ? { serverKey } : {}),
      ...(addresses.length ? { addresses } : {}),
      ...(registration && /^[A-Za-z0-9_-]{22}$/.test(registration) ? { registration } : {}),
      ...(token && /^[A-Za-z0-9_-]{22}$/.test(token) ? { token } : {}),
    };
  } catch {
    return null;
  }
}

/** Every address an invite names, in the order to try them (its own list first, then `s`). */
export function inviteAddresses(invite: Invite): string[] {
  const all = [...(invite.addresses ?? []), ...(invite.server ? [invite.server] : [])];
  return all.filter((a, i) => all.findIndex((b) => serverKey(b) === serverKey(a)) === i);
}
