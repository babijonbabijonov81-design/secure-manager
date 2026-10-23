// A minimal PCP client (RFC 6887): asks the router for a TCP port mapping. UPnP and NAT-PMP come
// from @achingbrain/nat-port-mapper; PCP, NAT-PMP's successor on many newer routers, is small
// enough to do here. Only MAP for TCP over IPv4.

import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';

const PCP_PORT = 5351;
const VERSION = 2;
const OP_MAP = 1;
const TCP = 6;

export interface PcpMapping {
  externalIp: string;
  externalPort: number;
  /** Seconds the router keeps it. */
  lifetime: number;
  nonce: Buffer;
}

const mappedV4 = (ip: string) => Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...ip.split('.').map(Number)]);

function request(gateway: string, packet: Buffer, timeoutMs: number, port = PCP_PORT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    let delay = 250;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error: Error | null, data?: Buffer) => {
      clearTimeout(timer);
      clearTimeout(overall);
      socket.close();
      if (error) reject(error);
      else resolve(data!);
    };
    // Retransmit with doubling intervals, as the RFC asks, until the overall timeout.
    const sendAgain = () => {
      socket.send(packet, port, gateway, (error) => error && finish(error));
      timer = setTimeout(sendAgain, (delay *= 2));
    };
    const overall = setTimeout(() => finish(new Error('Роутер не отвечает по PCP')), timeoutMs);
    socket.on('message', (data, from) => from.address === gateway && finish(null, data));
    socket.on('error', (error) => finish(error));
    sendAgain();
  });
}

/** MAP: lifetime 0 removes the mapping (with the same nonce). */
export async function pcpMap(options: {
  gateway: string;
  internalIp: string;
  port: number;
  lifetime: number;
  nonce?: Buffer;
  timeoutMs?: number;
  /** Tests: a fake router on another port. */
  serverPort?: number;
}): Promise<PcpMapping> {
  const nonce = options.nonce ?? randomBytes(12);
  const packet = Buffer.alloc(60);
  packet[0] = VERSION;
  packet[1] = OP_MAP;
  packet.writeUInt32BE(options.lifetime, 4);
  mappedV4(options.internalIp).copy(packet, 8);
  nonce.copy(packet, 24);
  packet[36] = TCP;
  packet.writeUInt16BE(options.port, 40);
  packet.writeUInt16BE(options.port, 42);
  // Suggested external address: any (all zeros, IPv4-mapped).
  mappedV4('0.0.0.0').copy(packet, 44);
  const answer = await request(options.gateway, packet, options.timeoutMs ?? 3000, options.serverPort);
  if (answer.length < 60 || answer[0] !== VERSION || answer[1] !== (0x80 | OP_MAP)) throw new Error('Роутер не поддерживает PCP');
  const result = answer[3];
  if (result !== 0) throw new Error(`Роутер отказал в пробросе по PCP (код ${result})`);
  const ip = [...answer.subarray(56, 60)].join('.');
  return { externalIp: ip, externalPort: answer.readUInt16BE(42), lifetime: answer.readUInt32BE(4), nonce };
}
