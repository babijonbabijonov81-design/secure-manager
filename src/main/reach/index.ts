// «Доступен из интернета»: the server on this computer, reachable from other networks.
//
// Three ways, tried in order and shown in Settings → Сервер:
//   1. a port opened on the router (UPnP-IGD, then PCP, then NAT-PMP), checked from outside;
//   2. a tunnel through a public Veil relay — works behind any NAT, including the provider's CGNAT;
//   3. an address the user typed (their domain, IP, ngrok or cloudflared).
// The resulting addresses go into veil:// invites, together with the server's key.

import { ed25519 } from '@noble/curves/ed25519.js';
import { b64 } from '../../../server/src/shared/wire.ts';
import { reachStatement } from '../../../server/src/shared/protocol.ts';
import type { RelayHandle } from '../../../server/src/relay.ts';
import { TunnelClient, type TunnelStatus } from '../../../server/src/tunnel.ts';
import { defaultGateway, isPrivateIPv4, localAddressFor } from './gateway.ts';
import { pcpMap } from './pcp.ts';

export interface ReachConfig {
  /** «Доступен из интернета». */
  internet: boolean;
  /** The public relay for the reachability check and the tunnel (host or URL). */
  publicRelay: string;
  /** «Внешний адрес», typed by the user. */
  manual: string;
  /** «Регистрация только по приглашению» (on by default while open to the internet). */
  inviteOnly: boolean;
}

export interface LevelStatus {
  state: 'off' | 'working' | 'ok' | 'failed';
  /** ws://ip:port, wss://…/t/<id>/ws or the typed address. */
  address?: string;
  /** In Russian, for the user: what happened or what to do. */
  text?: string;
}

export interface ReachStatus {
  internet: boolean;
  mapping: LevelStatus & { method?: 'UPnP' | 'PCP' | 'NAT-PMP' };
  tunnel: LevelStatus & { retryAt?: number };
  manual: LevelStatus;
  /** Every way in, best first: what invites carry. */
  addresses: string[];
  publicIp?: string;
}

const LEASE_S = 3600;

/** «host», «https://host», «wss://host/ws» → the relay's base URLs. */
export function relayUrls(input: string): { http: string; tunnel: string } | null {
  let value = input.trim();
  if (!value) return null;
  if (!/^[a-z]+:\/\//i.test(value)) value = `${/^(localhost|127\.|10\.|192\.168\.)/.test(value) ? 'http' : 'https'}://${value}`;
  try {
    const url = new URL(value.replace(/^ws/i, 'http'));
    const secure = url.protocol === 'https:';
    return { http: `${url.protocol}//${url.host}`, tunnel: `${secure ? 'wss' : 'ws'}://${url.host}/tunnel` };
  } catch {
    return null;
  }
}

type Release = () => Promise<void>;

export class ReachManager {
  private config: ReachConfig;
  private status: ReachStatus;
  private release: Release | null = null;
  private tunnel: TunnelClient | null = null;
  private recheck: ReturnType<typeof setInterval> | null = null;
  private generation = 0;

  constructor(
    private readonly options: {
      relay: () => RelayHandle | null;
      lanAddresses: () => string[];
      onStatus(status: ReachStatus): void;
      log?(message: string): void;
      /** The relay key the tunnel saw last time, kept in the app's config. */
      relayKey?: string;
      onRelayKey?(key: string): void;
      /** Tests: instead of asking a real router. */
      map?(port: number): Promise<{ method: 'UPnP' | 'PCP' | 'NAT-PMP'; externalIp: string; externalPort: number; release: Release } | null>;
      /** Tests: instead of reading the routing table. */
      gateway?: () => Promise<string | null>;
    },
    config: ReachConfig,
  ) {
    this.config = config;
    this.status = this.blank();
  }

  get current(): ReachStatus {
    return this.status;
  }

  private blank(): ReachStatus {
    return { internet: this.config.internet, mapping: { state: 'off' }, tunnel: { state: 'off' }, manual: { state: 'off' }, addresses: [] };
  }

  private publish(patch: Partial<ReachStatus>) {
    this.status = { ...this.status, ...patch, internet: this.config.internet };
    const addresses: string[] = [];
    if (this.status.manual.state === 'ok' && this.status.manual.address) addresses.push(this.status.manual.address);
    if (this.status.mapping.state === 'ok' && this.status.mapping.address) addresses.push(this.status.mapping.address);
    if (this.status.tunnel.state === 'ok' && this.status.tunnel.address) addresses.push(this.status.tunnel.address);
    addresses.push(...this.options.lanAddresses());
    this.status.addresses = addresses;
    this.options.onStatus(this.status);
  }

  /** New settings: everything is set up again from scratch. */
  async configure(config: ReachConfig): Promise<void> {
    this.config = config;
    await this.restart();
  }

  async restart(): Promise<void> {
    await this.stop();
    const relay = this.options.relay();
    if (!relay) return this.publish(this.blank());
    relay.setInviteOnly(this.config.internet && this.config.inviteOnly);
    if (!this.config.internet) return this.publish(this.blank());
    const generation = ++this.generation;
    this.status = this.blank();
    void this.checkManual(generation);
    const opened = await this.openPort(relay, generation);
    if (generation !== this.generation) return;
    if (!opened) this.startTunnel(relay);
    // Routers forget mappings and addresses change: look again every 30 minutes.
    this.recheck = setInterval(() => void this.restart(), 30 * 60_000);
    this.recheck.unref?.();
  }

  /** Server stopped or the app quits: the port mapping goes away and the tunnel closes. */
  async stop(): Promise<void> {
    this.generation++;
    if (this.recheck) clearInterval(this.recheck);
    this.recheck = null;
    this.tunnel?.stop();
    this.tunnel = null;
    const release = this.release;
    this.release = null;
    await release?.().catch(() => {});
  }

  // ---- 1. a port on the router -------------------------------------------------------------

  private async openPort(relay: RelayHandle, generation: number): Promise<boolean> {
    const urls = relayUrls(this.config.publicRelay);
    this.publish({ mapping: { state: 'working', text: 'Пробуем открыть порт на роутере…' } });
    const gateway = await (this.options.gateway ?? defaultGateway)();
    const internalIp = localAddressFor(gateway);
    if (!gateway || !internalIp) {
      this.publish({ mapping: { state: 'failed', text: 'Не нашли роутер этой сети' } });
      return false;
    }
    const mapping = this.options.map ? await this.options.map(relay.port) : await this.map(gateway, internalIp, relay.port);
    if (generation !== this.generation) {
      await mapping?.release().catch(() => {});
      return false;
    }
    if (!mapping) {
      this.publish({ mapping: { state: 'failed', text: 'Роутер не открывает порты сам (UPnP, PCP и NAT-PMP выключены или не поддерживаются)' } });
      return false;
    }
    this.release = mapping.release;
    // A grey address from the router means the provider's own NAT is in front: a port opened at
    // home leads nowhere.
    if (isPrivateIPv4(mapping.externalIp)) {
      await this.dropMapping();
      this.publish({ mapping: { state: 'failed', text: 'Провайдер не даёт белый IP — используем туннель' } });
      return false;
    }
    if (!urls) {
      this.publish({ mapping: { state: 'failed', method: mapping.method, text: 'Укажите публичный ретранслятор: без него нельзя проверить доступ снаружи' } });
      await this.dropMapping();
      return false;
    }
    const check = await this.checkFromOutside(urls.http, relay, mapping.externalPort).catch((error: Error) => ({ reachable: false, ip: '', error: error.message }));
    if (generation !== this.generation) return false;
    if (check.ip && check.ip !== mapping.externalIp) {
      await this.dropMapping();
      this.publish({
        publicIp: check.ip,
        mapping: { state: 'failed', method: mapping.method, text: 'Провайдер не даёт белый IP — используем туннель' },
      });
      return false;
    }
    if (!check.reachable) {
      await this.dropMapping();
      this.publish({
        ...(check.ip ? { publicIp: check.ip } : {}),
        mapping: {
          state: 'failed',
          method: mapping.method,
          text: 'error' in check && check.error ? check.error : 'Порт открыт, но снаружи не отвечает — возможно, мешает брандмауэр. Используем туннель',
        },
      });
      return false;
    }
    const address = `ws://${mapping.externalIp}:${mapping.externalPort}`;
    this.publish({ publicIp: check.ip, mapping: { state: 'ok', method: mapping.method, address, text: `Порт ${mapping.externalPort} открыт через ${mapping.method}` } });
    return true;
  }

  private async dropMapping() {
    const release = this.release;
    this.release = null;
    await release?.().catch(() => {});
  }

  private async map(
    gateway: string,
    internalIp: string,
    port: number,
  ): Promise<{ method: 'UPnP' | 'PCP' | 'NAT-PMP'; externalIp: string; externalPort: number; release: Release } | null> {
    const { upnpNat, pmpNat } = await import('@achingbrain/nat-port-mapper');
    const description = 'Veil server';
    // UPnP-IGD
    try {
      const client = upnpNat({ description, ttl: LEASE_S * 1000, autoRefresh: true });
      for await (const found of client.findGateways({ signal: AbortSignal.timeout(6000) })) {
        try {
          const mapped = await found.map(port, internalIp, { protocol: 'tcp', externalPort: port, signal: AbortSignal.timeout(6000) });
          const externalIp = await found.externalIp({ signal: AbortSignal.timeout(6000) });
          return { method: 'UPnP', externalIp, externalPort: mapped.externalPort, release: () => found.stop() };
        } catch {
          await found.stop().catch(() => {});
        }
      }
    } catch {
      // no UPnP gateway
    }
    // PCP
    try {
      let current = await pcpMap({ gateway, internalIp, port, lifetime: LEASE_S });
      const renew = setInterval(
        () => void pcpMap({ gateway, internalIp, port, lifetime: LEASE_S, nonce: current.nonce }).then((m) => (current = m), () => {}),
        (current.lifetime * 1000) / 2,
      );
      renew.unref?.();
      return {
        method: 'PCP',
        externalIp: current.externalIp,
        externalPort: current.externalPort,
        release: async () => {
          clearInterval(renew);
          await pcpMap({ gateway, internalIp, port, lifetime: 0, nonce: current.nonce }).catch(() => {});
        },
      };
    } catch {
      // no PCP
    }
    // NAT-PMP
    try {
      const pmp = pmpNat(gateway, { description, ttl: LEASE_S * 1000, autoRefresh: true });
      const mapped = await pmp.map(port, internalIp, { protocol: 'tcp', externalPort: port, signal: AbortSignal.timeout(6000) });
      const externalIp = await pmp.externalIp({ signal: AbortSignal.timeout(6000) });
      return { method: 'NAT-PMP', externalIp, externalPort: mapped.externalPort, release: () => pmp.stop() };
    } catch {
      return null;
    }
  }

  /** The public relay knocks on our own address from outside (see /reach on the relay). */
  private async checkFromOutside(http: string, relay: RelayHandle, port: number): Promise<{ reachable: boolean; ip: string; error?: string }> {
    const ts = Date.now();
    const sig = b64(ed25519.sign(reachStatement(port, ts), relay.store.serverSecretKey));
    const answer = await fetch(`${http}/reach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port, key: b64(relay.store.serverPublicKey), ts, sig }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await answer.json().catch(() => ({}))) as { reachable?: boolean; ip?: string; error?: string };
    if (answer.status === 404) return { reachable: false, ip: '', error: 'Этот ретранслятор не проверяет доступность (старая версия) — используем туннель' };
    return { reachable: !!data.reachable, ip: data.ip ?? '', ...(data.error ? { error: data.error } : {}) };
  }

  // ---- 2. a tunnel ---------------------------------------------------------------------------

  private startTunnel(relay: RelayHandle) {
    const urls = relayUrls(this.config.publicRelay);
    if (!urls) {
      this.publish({ tunnel: { state: 'failed', text: 'Укажите публичный ретранслятор для туннеля' } });
      return;
    }
    this.tunnel = new TunnelClient({
      url: urls.tunnel,
      secretKey: relay.store.serverSecretKey,
      publicKey: relay.store.serverPublicKey,
      accept: (channel, ip, challenge) => relay.accept(channel, ip, challenge),
      knownRelayKey: this.options.relayKey,
      onRelayKey: (key) => this.options.onRelayKey?.(key),
      onStatus: (s) => this.publish({ tunnel: describeTunnel(s), ...(s.publicIp ? { publicIp: s.publicIp } : {}) }),
    });
    this.tunnel.start();
  }

  // ---- 3. typed by hand ----------------------------------------------------------------------

  private async checkManual(generation: number) {
    const address = this.config.manual.trim();
    if (!address) return this.publish({ manual: { state: 'off' } });
    this.publish({ manual: { state: 'working', address, text: 'Проверяем адрес…' } });
    const relay = this.options.relay();
    const ok = await probeKey(address).then(
      (key) => !!relay && key === b64(relay.store.serverPublicKey),
      () => false,
    );
    if (generation !== this.generation) return;
    this.publish({
      manual: ok
        ? { state: 'ok', address, text: 'Отвечает этот сервер' }
        : { state: 'failed', address, text: 'По этому адресу не отвечает сервер этого компьютера (проверьте проброс порта или туннель ngrok/cloudflared)' },
    });
  }
}

function describeTunnel(s: TunnelStatus): ReachStatus['tunnel'] {
  if (s.state === 'online')
    return {
      state: 'ok',
      address: s.url,
      text: s.error ?? (s.relayKeyChanged ? 'Туннель работает (ключ ретранслятора сменился с прошлого раза)' : 'Туннель работает'),
    };
  if (s.state === 'connecting') return { state: 'working', text: 'Подключаемся к ретранслятору… (бесплатный Render просыпается до минуты)' };
  if (s.state === 'retrying') return { state: 'failed', text: s.error ?? 'Нет связи с ретранслятором', retryAt: s.retryAt };
  return { state: 'off' };
}

/** The key a server at `address` proves (with our own challenge). */
async function probeKey(address: string): Promise<string | undefined> {
  const { probeServer } = await import('../../core/relay-client.ts');
  return (await probeServer(address, 8000)).key;
}
