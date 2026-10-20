// Audio calls over WebRTC. The offer/answer (with the DTLS fingerprints that key the media
// encryption) travels inside Veil's end-to-end encrypted channel, so neither the relay nor a
// STUN/TURN server can listen in or slip itself between the two sides.
import { randomId } from '../../../../server/src/shared/wire.ts';
import type { Messenger } from '../../../core/messenger.ts';
import type { AudioSettings, CallEndReason, CallRecord, CallSignal, Contact } from '../../../core/types.ts';
import { openMicrophone, routeOutput, Tones } from './audio.ts';

export type CallPhase = 'outgoing' | 'ringing' | 'incoming' | 'connecting' | 'active' | 'reconnecting' | 'ended';

export interface CallState {
  id: string;
  contactId: string;
  dir: 'in' | 'out';
  phase: CallPhase;
  /** When audio started flowing. */
  connectedAt?: number;
  muted: boolean;
  minimized: boolean;
  /** Why the call ended, shown for a moment before the window closes. */
  endText?: string;
}

const RING_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 25_000;
const RECONNECT_GRACE_MS = 12_000;
const ICE_GATHER_MS = 2500;
const ENDED_LINGER_MS = 1800;

export interface CallManagerOptions {
  /** An incoming call is ringing (e.g. show a notification when the window is hidden). */
  onIncoming?(contact: Contact, callId: string): void;
  /** The call is over or answered: remove that notification. */
  onSettled?(callId: string): void;
}

export class CallManager {
  private state: CallState | null = null;
  private readonly listeners = new Set<() => void>();
  private pc: RTCPeerConnection | null = null;
  private local: MediaStream | null = null;
  private remote: MediaStream | null = null;
  private offerSdp = '';
  private readonly audio: HTMLAudioElement;
  private readonly tones = new Tones();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private linger: ReturnType<typeof setTimeout> | null = null;
  private input = '';

  constructor(
    private readonly messenger: Messenger,
    private readonly options: CallManagerOptions = {},
  ) {
    this.audio = new Audio();
    this.audio.autoplay = true;
    messenger.callHandler = (contact, signal) => this.onSignal(contact, signal);
    this.applySettings();
  }

  // ---- state for React (useSyncExternalStore) --------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): CallState | null => this.state;

  get localStream(): MediaStream | null {
    return this.local;
  }

  get remoteStream(): MediaStream | null {
    return this.remote;
  }

  private set(next: CallState | null): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private patch(fields: Partial<CallState>): void {
    if (this.state) this.set({ ...this.state, ...fields });
  }

  private get audioSettings(): AudioSettings {
    return this.messenger.getSnapshot().settings.audio;
  }

  /** Picks up a new speaker or microphone choice, also in the middle of a call. */
  applySettings(): void {
    const audio = this.audioSettings;
    this.tones.setOutput(audio.output);
    void routeOutput(this.audio, audio.output);
    if (this.input === audio.input) return;
    this.input = audio.input;
    void this.switchMicrophone();
  }

  private async switchMicrophone(): Promise<void> {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'audio');
    if (!sender || !this.local) return;
    try {
      const fresh = await openMicrophone(this.audioSettings);
      const track = fresh.getAudioTracks()[0];
      track.enabled = !this.state?.muted;
      await sender.replaceTrack(track);
      this.local.getTracks().forEach((t) => t.stop());
      this.local = fresh;
      this.set(this.state && { ...this.state });
    } catch {
      // keep the current microphone
    }
  }

  // ---- actions ------------------------------------------------------------------------------

  /** Calls a contact. Throws if calling is impossible right now (another call, offline, blocked). */
  async start(contactId: string): Promise<void> {
    if (this.state && this.state.phase !== 'ended') throw new Error('Сначала завершите текущий звонок');
    const contact = this.messenger.getSnapshot().contacts.find((c) => c.id === contactId);
    if (!contact) throw new Error('Контакт не найден');
    if (contact.blocked) throw new Error('Пользователь заблокирован');
    if (this.messenger.getSnapshot().status !== 'online') throw new Error('Нет соединения с сервером');
    this.checkRelayOnly();
    this.reset();
    const id = randomId();
    this.set({ id, contactId, dir: 'out', phase: 'outgoing', muted: false, minimized: false });
    try {
      const pc = await this.preparePeer();
      if (!this.live(id)) return;
      await pc.setLocalDescription(await pc.createOffer());
      await this.gathered(pc);
      if (!this.live(id)) return;
      const result = await this.messenger.sendCallSignal(contactId, { k: 'offer', id, sdp: pc.localDescription!.sdp });
      if (!this.live(id)) return;
      if (result === 'offline') {
        // They will find a missed call once they are back online.
        return this.finish('unavailable', 'Абонент не в сети', 'cancel');
      }
      this.arm(RING_TIMEOUT_MS, () => this.finish('missed', 'Нет ответа', 'timeout'));
    } catch (error) {
      // Shown in the call window (e.g. no microphone access).
      if (this.state?.id === id) this.finish('failed', (error as Error).message || 'Не удалось позвонить', 'failed');
    }
  }

  async accept(): Promise<void> {
    const s = this.state;
    if (!s || s.dir !== 'in' || s.phase !== 'incoming') return;
    this.tones.stop();
    this.options.onSettled?.(s.id);
    this.clearTimer();
    this.patch({ phase: 'connecting' });
    try {
      this.checkRelayOnly();
      const pc = await this.preparePeer();
      if (!this.live(s.id)) return;
      await pc.setRemoteDescription({ type: 'offer', sdp: this.offerSdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gathered(pc);
      if (!this.live(s.id)) return;
      await this.messenger.sendCallSignal(s.contactId, { k: 'answer', id: s.id, sdp: pc.localDescription!.sdp });
      this.arm(CONNECT_TIMEOUT_MS, () => this.finish('failed', 'Не удалось соединиться', 'failed'));
    } catch (error) {
      if (this.state?.id === s.id) this.finish('failed', (error as Error).message || 'Не удалось ответить', 'failed');
    }
  }

  decline(): void {
    const s = this.state;
    if (s?.dir === 'in' && s.phase === 'incoming') this.finish('declined', 'Звонок отклонён', 'decline');
  }

  /** Ends the call whatever its phase. */
  hangup(): void {
    const s = this.state;
    if (!s || s.phase === 'ended') return;
    if (s.phase === 'incoming') return this.decline();
    if (s.connectedAt) return this.finish('done', 'Звонок завершён', 'hangup');
    if (s.dir === 'out') return this.finish('cancelled', 'Звонок отменён', 'cancel');
    this.finish('declined', 'Звонок завершён', 'hangup');
  }

  toggleMute(): void {
    const s = this.state;
    if (!s) return;
    const muted = !s.muted;
    this.local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.patch({ muted });
  }

  setMinimized(minimized: boolean): void {
    this.patch({ minimized });
  }

  /** Locking or closing the app hangs up. */
  dispose(): void {
    this.hangup();
    this.reset();
    this.tones.stop();
    if (this.messenger.callHandler) this.messenger.callHandler = null;
    this.listeners.clear();
  }

  // ---- signalling -----------------------------------------------------------------------------

  private onSignal(contact: Contact, signal: CallSignal): boolean {
    const s = this.state;
    const mine = !!s && s.id === signal.id;
    switch (signal.k) {
      case 'offer': {
        if (mine) return true;
        if (s && s.phase !== 'ended') {
          // Both called each other at once: the call with the smaller id wins on both sides.
          const glare = s.dir === 'out' && s.contactId === contact.id && (s.phase === 'outgoing' || s.phase === 'ringing');
          if (!glare || signal.id > s.id) {
            if (!glare) {
              void this.messenger.sendCallSignal(contact.id, { k: 'end', id: signal.id, r: 'busy' }).catch(() => {});
              this.messenger.logCall(contact.id, 'in', { status: 'busy' }, signal.id);
            }
            return true;
          }
        }
        this.reset();
        this.offerSdp = signal.sdp;
        this.set({ id: signal.id, contactId: contact.id, dir: 'in', phase: 'incoming', muted: false, minimized: false });
        void this.messenger.sendCallSignal(contact.id, { k: 'ring', id: signal.id }).catch(() => {});
        this.tones.play('incoming');
        this.options.onIncoming?.(contact, signal.id);
        // The caller gives up after RING_TIMEOUT_MS; this only covers a lost "end".
        this.arm(RING_TIMEOUT_MS + 5000, () => this.finish('missed', 'Пропущенный звонок'));
        return true;
      }
      case 'ring':
        if (mine && s!.phase === 'outgoing') {
          this.patch({ phase: 'ringing' });
          this.tones.play('ringback');
        }
        return mine;
      case 'answer':
        if (mine && s!.dir === 'out' && (s!.phase === 'outgoing' || s!.phase === 'ringing') && this.pc) {
          this.tones.stop();
          this.patch({ phase: 'connecting' });
          this.arm(CONNECT_TIMEOUT_MS, () => this.finish('failed', 'Не удалось соединиться', 'failed'));
          this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp }).catch(() => this.finish('failed', 'Не удалось соединиться', 'failed'));
        }
        return mine;
      case 'end': {
        if (!mine || s!.phase === 'ended') return mine;
        const r = signal.r;
        if (s!.connectedAt) this.finish('done', 'Звонок завершён');
        else if (s!.dir === 'in') this.finish('missed', 'Пропущенный звонок');
        else if (r === 'decline') this.finish('declined', 'Абонент отклонил звонок');
        else if (r === 'busy') this.finish('busy', 'Абонент занят');
        else this.finish('failed', r === 'failed' ? 'Не удалось соединиться' : 'Звонок прерван');
        return true;
      }
    }
  }

  // ---- WebRTC ---------------------------------------------------------------------------------

  private checkRelayOnly(): void {
    if (this.messenger.getSnapshot().settings.callsRelayOnly && !this.messenger.iceServers.hasTurn)
      throw new Error('Включено «Скрывать мой IP в звонках», но на сервере нет TURN. Отключите это в Настройки → Аудио');
  }

  private async preparePeer(): Promise<RTCPeerConnection> {
    this.local = await openMicrophone(this.audioSettings);
    this.input = this.audioSettings.input;
    const { servers, hasTurn } = this.messenger.iceServers;
    const relayOnly = this.messenger.getSnapshot().settings.callsRelayOnly && hasTurn;
    const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: relayOnly ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
    this.pc = pc;
    for (const track of this.local.getAudioTracks()) {
      track.enabled = !this.state?.muted;
      pc.addTrack(track, this.local);
    }
    pc.ontrack = (event) => {
      this.remote = event.streams[0] ?? new MediaStream([event.track]);
      this.audio.srcObject = this.remote;
      void this.audio.play().catch(() => {});
      this.set(this.state && { ...this.state });
    };
    pc.onconnectionstatechange = () => this.onConnectionState(pc);
    return pc;
  }

  /** Waits for ICE candidates so a single message carries them all (no trickle ICE). */
  private gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    const limit = this.messenger.getSnapshot().settings.callsRelayOnly ? ICE_GATHER_MS * 2 : ICE_GATHER_MS;
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => pc.iceGatheringState === 'complete' && finish();
      const timer = setTimeout(finish, limit);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  private onConnectionState(pc: RTCPeerConnection): void {
    const s = this.state;
    if (pc !== this.pc || !s || s.phase === 'ended') return;
    switch (pc.connectionState) {
      case 'connected':
        this.clearTimer();
        if (s.phase !== 'active') {
          if (!s.connectedAt) this.tones.play('connected');
          this.patch({ phase: 'active', connectedAt: s.connectedAt ?? Date.now() });
        }
        return;
      case 'disconnected':
        if (s.phase === 'active') {
          this.patch({ phase: 'reconnecting' });
          this.arm(RECONNECT_GRACE_MS, () => this.finish('done', 'Связь потеряна', 'failed'));
        }
        return;
      case 'failed':
        this.finish(s.connectedAt ? 'done' : 'failed', s.connectedAt ? 'Связь потеряна' : 'Не удалось соединиться', 'failed');
        return;
    }
  }

  // ---- housekeeping ---------------------------------------------------------------------------

  private finish(status: CallRecord['status'], endText: string, tell?: CallEndReason): void {
    const s = this.state;
    if (!s || s.phase === 'ended') return;
    if (tell) void this.messenger.sendCallSignal(s.contactId, { k: 'end', id: s.id, r: tell }).catch(() => {});
    const dur = s.connectedAt ? Math.max(1, Math.round((Date.now() - s.connectedAt) / 1000)) : 0;
    this.messenger.logCall(s.contactId, s.dir, { status, ...(dur ? { dur } : {}) }, s.id);
    this.closeMedia();
    this.clearTimer();
    this.tones.play(status === 'busy' ? 'busy' : 'end');
    this.options.onSettled?.(s.id);
    this.set({ ...s, phase: 'ended', endText, minimized: false });
    this.linger = setTimeout(() => this.state?.id === s.id && this.set(null), ENDED_LINGER_MS);
  }

  /** Still the same, unfinished call after an await? */
  private live(id: string): boolean {
    return this.state?.id === id && this.state.phase !== 'ended';
  }

  private arm(ms: number, fn: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(fn, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private closeMedia(): void {
    this.pc?.close();
    this.pc = null;
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.remote = null;
    this.audio.srcObject = null;
  }

  /** Drops any previous call without telling anyone (it already ended). */
  private reset(): void {
    this.closeMedia();
    this.clearTimer();
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    this.tones.stop();
    this.offerSdp = '';
    this.state = null;
  }
}
