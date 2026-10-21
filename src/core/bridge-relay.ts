// «Мост» through the relay, when the two computers share no network: both join a room on the
// relay, which pipes the (already encrypted) bridge frames between them and sees nothing else.

import type { ServerFrame } from '../../server/src/shared/protocol.ts';
import { pack, randomId, unpack } from '../../server/src/shared/wire.ts';
import type { BridgeChannel } from './bridge.ts';
import { normalizeServerUrl, RelayRequestError } from './relay-client.ts';

/**
 * Opens (host) or joins (guest) a room. Resolves once the room exists (host) or both sides are
 * there (guest); the host's channel becomes usable when `onPeer` fires.
 */
export function relayBridgeChannel(
  server: string,
  room: string,
  role: 'host' | 'guest',
  onPeer?: (channel: BridgeChannel) => void,
): Promise<BridgeChannel> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(normalizeServerUrl(server));
    } catch (error) {
      reject(error);
      return;
    }
    ws.binaryType = 'arraybuffer';
    let onData: (data: Uint8Array) => void = () => {};
    let onClose: () => void = () => {};
    let settled = false;
    const reqId = randomId(9);
    const channel: BridgeChannel = {
      send: (data) => ws.readyState === WebSocket.OPEN && ws.send(pack({ type: 'bridge_data' }, data)),
      onData: (cb) => (onData = cb),
      onClose: (cb) => (onClose = cb),
      close: () => ws.close(),
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new RelayRequestError('timeout', 'Сервер не отвечает'));
    }, 20_000);
    ws.onmessage = (event) => {
      let frame: ServerFrame;
      let body: Uint8Array;
      try {
        ({ header: frame, body } = unpack<ServerFrame>(new Uint8Array(event.data as ArrayBuffer)));
      } catch {
        return;
      }
      if (frame.type === 'hello') ws.send(pack({ type: role === 'host' ? 'bridge_open' : 'bridge_join', reqId, room }));
      else if (frame.type === 'error' && !settled) {
        settled = true;
        clearTimeout(timer);
        ws.close();
        reject(new RelayRequestError(frame.code, frame.message));
      } else if (frame.type === 'result' && frame.reqId === reqId && role === 'host' && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(channel);
      } else if (frame.type === 'bridge_peer') {
        if (role === 'guest' && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(channel);
        } else onPeer?.(channel);
      } else if (frame.type === 'bridge_data') onData(body.slice());
      else if (frame.type === 'bridge_closed') ws.close();
    };
    ws.onclose = () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new RelayRequestError('offline', 'Нет соединения с сервером'));
      } else onClose();
    };
  });
}
