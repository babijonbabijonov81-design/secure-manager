// A Veil server at home reachable through a tunnel on a public relay: several clients at once,
// the home server's own key end to end, limits, a forged open frame, and a relay restart.
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { startRelay, type RelayHandle } from '../server/src/relay.ts';
import { pack, unpack } from '../server/src/shared/wire.ts';
import { TunnelClient, tunnelId, type TunnelFrame, type TunnelLimits, type TunnelStatus } from '../server/src/tunnel.ts';
import { probeServer } from '../src/core/relay-client.ts';
import { lastText, makeUser, waitFor } from './helpers.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function publicRelay(limits: Partial<TunnelLimits> = {}, port = 0): Promise<RelayHandle> {
  const relay = await startRelay({ port, host: '127.0.0.1', dataDir: null, tunnels: limits });
  cleanup.push(() => relay.close());
  return relay;
}

async function homeServer(): Promise<RelayHandle> {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: null });
  cleanup.push(() => relay.close());
  return relay;
}

function tunnel(home: RelayHandle, publicPort: number) {
  const statuses: TunnelStatus[] = [];
  const client = new TunnelClient({
    url: `ws://127.0.0.1:${publicPort}/tunnel`,
    secretKey: home.store.serverSecretKey,
    publicKey: home.store.serverPublicKey,
    accept: (channel, ip, challenge) => home.accept(channel, ip, challenge),
    onStatus: (s) => statuses.push(s),
    minBackoffMs: 50,
    maxBackoffMs: 400,
  });
  client.start();
  cleanup.push(() => client.stop());
  return { client, statuses };
}

describe('tunnels', () => {
  it('carries several clients at once to the home server, proving the home key', async () => {
    const pub = await publicRelay();
    const home = await homeServer();
    const { client } = tunnel(home, pub.port);
    await waitFor(() => client.current.state === 'online');
    const url = client.current.url!;
    expect(url).toBe(`ws://127.0.0.1:${pub.port}/t/${tunnelId(home.store.serverPublicKey)}/ws`);
    expect(client.current.publicIp).toBe('127.0.0.1');

    // The hello behind the tunnel is signed by the HOME server's key, not the relay's.
    const probe = await probeServer(url);
    expect(probe.id).toBe(home.store.serverId);
    expect(probe.key).not.toBe((await probeServer(`ws://127.0.0.1:${pub.port}`)).key);

    const [anna, boris, vera] = await Promise.all(['anna', 'boris', 'vera'].map((n) => makeUser(url, n)));
    expect(home.store.users.size).toBe(3);
    expect(pub.store.users.size).toBe(0);
    await anna.messenger.addContact(boris.username);
    await anna.messenger.sendText(boris.id, 'через туннель');
    await waitFor(() => lastText(boris.messenger, anna.id) === 'через туннель');
    await vera.messenger.addContact(anna.username);
    await vera.messenger.sendText(anna.id, 'и я тут');
    await waitFor(() => lastText(anna.messenger, vera.id) === 'и я тут');
    for (const u of [anna, boris, vera]) cleanup.push(() => u.messenger.dispose());
  });

  it('comes back at the same address after the public relay restarts', async () => {
    const first = await publicRelay();
    const port = first.port;
    const home = await homeServer();
    const { client, statuses } = tunnel(home, port);
    await waitFor(() => client.current.state === 'online');
    const url = client.current.url!;
    const anna = await makeUser(url, 'anna');
    cleanup.push(() => anna.messenger.dispose());

    // Render restarts the service: everything in its memory is gone.
    await first.close();
    await waitFor(() => statuses.some((s) => s.state === 'retrying'));
    await publicRelay({}, port);
    await waitFor(() => client.current.state === 'online', 8000);
    expect(client.current.url).toBe(url);
    // The client reconnects by itself and is the same account on the home server.
    await waitFor(() => anna.messenger.getSnapshot().status === 'online', 15_000);
    expect(home.store.users.has(anna.id)).toBe(true);
  });

  it('keeps to its limits', async () => {
    const pub = await publicRelay({ perIp: 1, connsPerTunnel: 2 });
    const home = await homeServer();
    const other = await homeServer();
    const { client } = tunnel(home, pub.port);
    await waitFor(() => client.current.state === 'online');
    // A second tunnel from the same IP is refused.
    const { client: second } = tunnel(other, pub.port);
    await waitFor(() => second.current.state === 'retrying' && /лимит|места/.test(second.current.error ?? ''));

    // Two clients fit, the third is turned away.
    const open = () =>
      new Promise<number | 'open'>((resolve) => {
        const ws = new WebSocket(client.current.url!);
        cleanup.push(() => ws.close());
        ws.on('message', () => resolve('open'));
        ws.on('close', (code) => resolve(code));
      });
    expect(await open()).toBe('open');
    expect(await open()).toBe('open');
    expect(await open()).toBe(4429);
  });

  it('cuts a tunnel that used up its daily traffic', async () => {
    const pub = await publicRelay({ bytesPerDay: 4000 });
    const home = await homeServer();
    const { client } = tunnel(home, pub.port);
    await waitFor(() => client.current.state === 'online');
    const ws = new WebSocket(client.current.url!);
    const closed = new Promise<number>((resolve) => ws.on('close', resolve));
    await new Promise((r) => ws.on('message', r));
    ws.send(pack({ type: 'ping' }, new Uint8Array(5000)));
    expect(await closed).toBe(4429);
    await waitFor(() => /лимит/.test(client.current.error ?? ''));
  });

  it('refuses a client address the relay did not sign', async () => {
    // A fake "relay" that registers the tunnel, then opens a connection with a forged signature.
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    cleanup.push(() => new Promise((r) => fake.close(r)));
    const closedWith = new Promise<number | undefined>((resolve) => {
      fake.on('connection', (ws) => {
        ws.send(pack({ type: 't_hello', nonce: 'n', key: 'A'.repeat(43) } satisfies TunnelFrame));
        ws.on('message', (raw) => {
          const { header } = unpack<TunnelFrame>(new Uint8Array(raw as Buffer));
          if (header.type === 't_register') {
            ws.send(pack({ type: 't_ready', id: 'abcdefghijklmnop', ip: '1.2.3.4' } satisfies TunnelFrame));
            ws.send(pack({ type: 't_open', vc: 7, ip: '6.6.6.6', c: 'x', sig: 'B'.repeat(86) } satisfies TunnelFrame));
          } else if (header.type === 't_close') resolve(header.code);
        });
      });
    });
    const home = await homeServer();
    let accepted = 0;
    const client = new TunnelClient({
      url: `ws://127.0.0.1:${(fake.address() as { port: number }).port}/tunnel`,
      secretKey: home.store.serverSecretKey,
      publicKey: home.store.serverPublicKey,
      accept: () => accepted++,
      onStatus: () => {},
    });
    client.start();
    cleanup.push(() => client.stop());
    expect(await closedWith).toBe(4401);
    expect(accepted).toBe(0);
  });
});
