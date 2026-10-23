// The router of this computer's network: the default gateway, and our own address next to it.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

const run = (command: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(command, args, { timeout: 4000, windowsHide: true }, (_error, stdout) => resolve(String(stdout ?? ''))));

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;

/** The default IPv4 gateway, or null. */
export async function defaultGateway(): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      // /proc/net/route: Destination 00000000 is the default route; addresses are little-endian hex.
      for (const line of (await readFile('/proc/net/route', 'utf8')).split('\n').slice(1)) {
        const [, destination, gateway] = line.trim().split(/\s+/);
        if (destination !== '00000000' || !gateway || gateway === '00000000') continue;
        const bytes = gateway.match(/../g)!.map((h) => parseInt(h, 16)).reverse();
        return bytes.join('.');
      }
      return null;
    }
    if (process.platform === 'darwin') return IPV4.exec(/gateway:\s*(\S+)/.exec(await run('route', ['-n', 'get', 'default']))?.[1] ?? '')?.[1] ?? null;
    if (process.platform === 'win32') {
      // «0.0.0.0  0.0.0.0  <gateway>  <interface>  <metric>» in the IPv4 route table.
      const line = (await run('route', ['print', '-4', '0.0.0.0'])).split('\n').find((l) => /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\d/.test(l));
      return line ? (line.trim().split(/\s+/)[2] ?? null) : null;
    }
  } catch {
    // no routing information
  }
  return null;
}

/** This computer's address in the gateway's network (same /24, else the first private IPv4). */
export function localAddressFor(gateway: string | null): string | null {
  const all = Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  const prefix = gateway?.split('.').slice(0, 3).join('.');
  return all.find((a) => prefix && a.startsWith(`${prefix}.`)) ?? all.find(isPrivateIPv4) ?? all[0] ?? null;
}

/** 10/8, 172.16/12, 192.168/16, 169.254/16 — and 100.64/10, the provider's shared space (CGNAT). */
export function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 127;
}
