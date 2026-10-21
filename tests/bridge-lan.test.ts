import { describe, expect, it } from 'vitest';
import { BridgeGuest, BridgeHost, type BridgeChannel } from '../src/core/bridge.ts';
import { discoverBridges, LanBridge, type Notify } from '../src/main/bridge.ts';
import { waitFor } from './helpers.ts';

/** A bridge channel over a LanBridge, the way the renderer sees it through IPC. */
function lan(): { bridge: LanBridge; channel: BridgeChannel; peers: number[] } {
  let onData: (d: Uint8Array) => void = () => {};
  let onClose: () => void = () => {};
  const peers: number[] = [];
  const notify: Notify = (event, value) => {
    if (event === 'bridge:data') onData(value!);
    else if (event === 'bridge:closed') onClose();
    else peers.push(Date.now());
  };
  const bridge = new LanBridge(notify);
  return {
    bridge,
    peers,
    channel: { send: (d) => bridge.send(d), onData: (cb) => (onData = cb), onClose: (cb) => (onClose = cb), close: () => bridge.drop() },
  };
}

describe('«Мост» over TCP on the local network', () => {
  it('carries the handshake and a few megabytes between two computers', async () => {
    const old = lan();
    const fresh = lan();
    const big = new Uint8Array(5 * 1024 * 1024).map((_, i) => i % 251);
    let sas = '';
    let done = false;
    const host = new BridgeHost(
      { names: async () => ['account', 'att.big'], get: async (n) => (n === 'account' ? new TextEncoder().encode('{}') : big) },
      { onSas: (s) => (sas = s), onDone: () => (done = true) },
    );
    const { port } = await old.bridge.host(false);
    await fresh.bridge.connect('127.0.0.1', port);
    await waitFor(() => old.peers.length === 1);
    host.attach(old.channel);
    let records: Map<string, Uint8Array> | null = null;
    let guestSas = '';
    const guest = new BridgeGuest(fresh.channel, host.code, { onSas: (s) => (guestSas = s), onRecords: (r) => (records = r) });
    guest.start();
    await waitFor(() => sas && guestSas);
    expect(guestSas).toBe(sas);
    await host.confirm();
    const got = await waitFor(() => records, 15_000);
    expect(Buffer.from(got.get('att.big')!).equals(Buffer.from(big))).toBe(true);
    guest.finish();
    await waitFor(() => done);
    old.bridge.stop();
    fresh.bridge.stop();
  });

  it('announces itself over mDNS when multicast works', async () => {
    const old = lan();
    const { port } = await old.bridge.host(true);
    const found = await discoverBridges(2000);
    old.bridge.stop();
    // Containers without multicast find nothing; when found, the port must match.
    for (const f of found) expect(typeof f.host).toBe('string');
    if (found.length) expect(found.some((f) => f.port === port)).toBe(true);
  });
});
