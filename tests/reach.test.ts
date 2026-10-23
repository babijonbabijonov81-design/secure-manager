// «Доступен из интернета»: the reachability check on a public relay (only its asker's own address
// and port), PCP against a fake router, and the order of ways in: port, tunnel, typed address.
import { createSocket } from 'node:dgram';
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startRelay, type RelayHandle } from '../server/src/relay.ts';
import { reachStatement } from '../server/src/shared/protocol.ts';
import { b64 } from '../server/src/shared/wire.ts';
import { isPrivateIPv4 } from '../src/main/reach/gateway.ts';
import { ReachManager, relayUrls, type ReachStatus } from '../src/main/reach/index.ts';
import { pcpMap } from '../src/main/reach/pcp.ts';
import { waitFor } from './helpers.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const relay = async (options: Parameters<typeof startRelay>[0] = {}) => {
  const r = await startRelay({ port: 0, host: '127.0.0.1', dataDir: null, ...options });
  cleanup.push(() => r.close());
  return r;
};

const ask = (pub: RelayHandle, home: RelayHandle, port: number, body: Record<string, unknown> = {}) => {
  const ts = Date.now();
  return fetch(`http://127.0.0.1:${pub.port}/reach`, {
    method: 'POST',
    body: JSON.stringify({ port, key: b64(home.store.serverPublicKey), ts, sig: b64(ed25519.sign(reachStatement(port, ts), home.store.serverSecretKey)), ...body }),
  });
};

describe('reachability check', () => {
  it('knocks only on the asker, on one port, and only counts this server', async () => {
    const pub = await relay({ tunnels: {} });
    const home = await relay();
    const elsewhere = await relay();
    const ok = await (await ask(pub, home, home.port)).json();
    expect(ok).toEqual({ reachable: true, ip: '127.0.0.1' });
    // Another Veil server on that port is not «this server».
    expect((await (await ask(pub, home, elsewhere.port)).json()).reachable).toBe(false);
    // No way to point it anywhere else: a host field is ignored, the signature must match.
    expect(await (await ask(pub, home, home.port, { host: '10.0.0.1' })).json()).toEqual({ reachable: true, ip: '127.0.0.1' });
    expect((await ask(pub, home, home.port, { sig: b64(new Uint8Array(64)) })).status).toBe(401);
    // Three checks an hour.
    expect((await ask(pub, home, home.port)).status).toBe(429);
    // Relays without tunnels do not offer it at all.
    expect((await ask(home, home, home.port)).status).toBe(404);
  });
});

describe('PCP', () => {
  it('asks the router for a TCP port and reads the answer', async () => {
    const router = createSocket('udp4');
    await new Promise<void>((r) => router.bind(0, '127.0.0.1', r));
    cleanup.push(() => router.close());
    router.on('message', (req, from) => {
      expect(req[0]).toBe(2);
      expect(req[1]).toBe(1);
      expect(req[36]).toBe(6);
      const res = Buffer.alloc(60);
      res[0] = 2;
      res[1] = 0x81;
      res.writeUInt32BE(req.readUInt32BE(4), 4);
      req.copy(res, 24, 24, 44);
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 203, 0, 113, 7]).copy(res, 44);
      router.send(res, from.port, from.address);
    });
    const mapping = await pcpMap({ gateway: '127.0.0.1', internalIp: '192.168.1.20', port: 8787, lifetime: 3600, serverPort: router.address().port });
    expect(mapping).toMatchObject({ externalIp: '203.0.113.7', externalPort: 8787, lifetime: 3600 });
  });
});

describe('ways in', () => {
  it('tells CGNAT apart, falls back to the tunnel and checks a typed address by the server key', async () => {
    const pub = await relay({ tunnels: {} });
    const home = await relay();
    const stranger = await relay();
    let released = 0;
    const statuses: ReachStatus[] = [];
    const manager = new ReachManager(
      {
        relay: () => home,
        lanAddresses: () => ['ws://192.168.1.20:8787'],
        onStatus: (s) => statuses.push(s),
        gateway: async () => '192.168.1.1',
        // The router hands out a grey address: the provider's NAT is in front.
        map: async (port) => ({ method: 'UPnP', externalIp: '100.64.3.9', externalPort: port, release: async () => void released++ }),
      },
      { internet: true, publicRelay: `http://127.0.0.1:${pub.port}`, manual: `ws://127.0.0.1:${stranger.port}`, inviteOnly: true },
    );
    cleanup.push(() => manager.stop());
    await manager.restart();
    await waitFor(() => manager.current.tunnel.state === 'ok' && manager.current.manual.state === 'failed', 10_000);
    const status = manager.current;
    expect(status.mapping).toMatchObject({ state: 'failed', text: 'Провайдер не даёт белый IP — используем туннель' });
    expect(released).toBe(1);
    expect(status.addresses[0]).toMatch(/\/t\/[a-z2-7]{16}\/ws$/);
    expect(status.addresses).toContain('ws://192.168.1.20:8787');
    expect(home.inviteOnly).toBe(true);

    // The typed address of THIS server passes; turning the internet off closes everything.
    await manager.configure({ internet: true, publicRelay: `http://127.0.0.1:${pub.port}`, manual: `ws://127.0.0.1:${home.port}`, inviteOnly: true });
    await waitFor(() => manager.current.manual.state === 'ok', 10_000);
    expect(manager.current.addresses[0]).toBe(`ws://127.0.0.1:${home.port}`);
    await manager.configure({ internet: false, publicRelay: '', manual: '', inviteOnly: true });
    expect(manager.current.tunnel.state).toBe('off');
    expect(home.inviteOnly).toBe(false);
  });

  it('knows grey addresses and relay URLs', () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.0.5', '100.64.0.1', '100.127.255.254']) expect(isPrivateIPv4(ip)).toBe(true);
    for (const ip of ['203.0.113.7', '100.128.0.1', '8.8.8.8']) expect(isPrivateIPv4(ip)).toBe(false);
    expect(relayUrls('veil.onrender.com')).toEqual({ http: 'https://veil.onrender.com', tunnel: 'wss://veil.onrender.com/tunnel' });
    expect(relayUrls('wss://veil.onrender.com/ws')).toEqual({ http: 'https://veil.onrender.com', tunnel: 'wss://veil.onrender.com/tunnel' });
    expect(relayUrls('')).toBeNull();
  });
});
