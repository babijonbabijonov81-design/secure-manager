// Audio and video calls over WebRTC. The offer/answer (with the DTLS fingerprints that key the
// media encryption) travels inside Veil's end-to-end encrypted channel, so neither the relay nor a
// STUN/TURN server can listen in or slip itself between the two sides.
//
// Video (features.video): every call negotiates two video channels up front, one for the camera
// and one for the screen, with nothing on them. Switching the camera or the screen on later only
// puts a track on a channel (replaceTrack), so no second offer/answer is needed; the other side
// learns what is on through a `media` signal, also end-to-end encrypted.
import { randomId } from '../../../../server/src/shared/wire.ts';
import { callWords, sdpFingerprint } from '../../../core/call-words.ts';
import type { Messenger } from '../../../core/messenger.ts';
import type { AudioSettings, CallEndReason, CallRecord, CallSignal, Contact } from '../../../core/types.ts';
import { openMicrophone, routeOutput, Tones } from './audio.ts';
import { feature } from './hooks.ts';
import { openCamera, openScreen } from './video.ts';

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
  /** «Слова-сверка» from both DTLS fingerprints, once connected. */
  words?: [string, string];
  /** The person said the words matched (or not) in this call. */
  wordsChecked?: boolean;
  /** Video channels were negotiated: the camera and the screen can be switched on. */
  video?: boolean;
  /** An incoming call was made as a video call. */
  videoCall?: boolean;
  /** My camera / my screen is being sent. */
  cam?: boolean;
  screen?: boolean;
  /** The other side's camera / screen is on. */
  remoteCam?: boolean;
  remoteScreen?: boolean;
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
  private camera: MediaStream | null = null;
  private display: MediaStream | null = null;
  private remoteCamera: MediaStream | null = null;
  private remoteDisplay: MediaStream | null = null;
  private camSender: RTCRtpSender | null = null;
  private screenSender: RTCRtpSender | null = null;
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

  get cameraStream(): MediaStream | null {
    return this.camera;
  }

  get remoteCameraStream(): MediaStream | null {
    return this.remoteCamera;
  }

  get remoteScreenStream(): MediaStream | null {
    return this.remoteDisplay;
  }

  private get videoEnabled(): boolean {
    return feature(this.messenger.getSnapshot().settings, 'video') && typeof RTCRtpTransceiver !== 'undefined';
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
  async start(contactId: string, options: { video?: boolean } = {}): Promise<void> {
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
      const pc = await this.preparePeer(true);
      if (!this.live(id)) return;
      const video = !!options.video && !!this.camSender;
      if (video) await this.setCamera(true, false);
      if (!this.live(id)) return;
      await pc.setLocalDescription(await pc.createOffer());
      await this.gathered(pc);
      if (!this.live(id)) return;
      const result = await this.messenger.sendCallSignal(contactId, { k: 'offer', id, sdp: pc.localDescription!.sdp, ...(video ? { v: 1 as const } : {}) });
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

  /** Answers; with `video` the camera is on from the start. */
  async accept(options: { video?: boolean } = {}): Promise<void> {
    const s = this.state;
    if (!s || s.dir !== 'in' || s.phase !== 'incoming') return;
    this.tones.stop();
    this.options.onSettled?.(s.id);
    this.clearTimer();
    this.patch({ phase: 'connecting' });
    try {
      this.checkRelayOnly();
      const pc = await this.preparePeer(false);
      if (!this.live(s.id)) return;
      await pc.setRemoteDescription({ type: 'offer', sdp: this.offerSdp });
      this.takeVideoChannels(pc);
      if (options.video && this.camSender) await this.setCamera(true, false);
      if (!this.live(s.id)) return;
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gathered(pc);
      if (!this.live(s.id)) return;
      await this.messenger.sendCallSignal(s.contactId, { k: 'answer', id: s.id, sdp: pc.localDescription!.sdp });
      if (this.state?.cam) this.sendMedia();
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

  /** Both fingerprints, local and remote, come from the SDPs exchanged end-to-end encrypted. */
  private words(pc: RTCPeerConnection): [string, string] | undefined {
    const local = sdpFingerprint(pc.localDescription?.sdp);
    const remote = sdpFingerprint(pc.remoteDescription?.sdp);
    return local && remote ? callWords(local, remote) : undefined;
  }

  /** «Совпало» marks the contact as verified by voice; «Не совпало» warns and hangs up. */
  checkWords(match: boolean): void {
    const s = this.state;
    if (!s?.words || s.wordsChecked) return;
    this.messenger.confirmCallWords(s.contactId, match);
    this.patch({ wordsChecked: true });
    if (!match) this.hangup();
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

  /** Switches my camera on or off (tells the other side unless `tell` is false). */
  async setCamera(on: boolean, tell = true): Promise<void> {
    const s = this.state;
    if (!s || s.phase === 'ended' || !this.camSender) return;
    if (on) {
      const stream = await openCamera(this.audioSettings.camera);
      if (!this.live(s.id) || !this.camSender) return stream.getTracks().forEach((t) => t.stop());
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'motion';
      await this.camSender.replaceTrack(track);
      this.camera?.getTracks().forEach((t) => t.stop());
      this.camera = stream;
    } else {
      await this.camSender.replaceTrack(null);
      this.camera?.getTracks().forEach((t) => t.stop());
      this.camera = null;
    }
    this.patch({ cam: on });
    if (tell) this.sendMedia();
  }

  /** Shows my screen or a window (the source was chosen before, see ScreenPicker). */
  async startScreen(): Promise<void> {
    const s = this.state;
    if (!s || s.phase === 'ended' || !this.screenSender || s.screen) return;
    const stream = await openScreen();
    if (!this.live(s.id) || !this.screenSender) return stream.getTracks().forEach((t) => t.stop());
    const track = stream.getVideoTracks()[0];
    // Text stays sharp rather than smooth.
    track.contentHint = 'detail';
    track.onended = () => void this.stopScreen();
    await this.screenSender.replaceTrack(track);
    try {
      const params = this.screenSender.getParameters();
      params.degradationPreference = 'maintain-resolution';
      await this.screenSender.setParameters(params);
    } catch {
      // not supported here
    }
    this.display = stream;
    this.patch({ screen: true });
    this.sendMedia();
  }

  async stopScreen(): Promise<void> {
    if (!this.state?.screen) return;
    await this.screenSender?.replaceTrack(null).catch(() => {});
    this.display?.getTracks().forEach((t) => t.stop());
    this.display = null;
    this.patch({ screen: false });
    this.sendMedia();
  }

  private sendMedia(): void {
    const s = this.state;
    if (!s || s.phase === 'ended' || !s.video) return;
    void this.messenger.sendCallSignal(s.contactId, { k: 'media', id: s.id, cam: !!s.cam, scr: !!s.screen }).catch(() => {});
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
        const videoCall = signal.v === 1 && this.videoEnabled;
        this.set({ id: signal.id, contactId: contact.id, dir: 'in', phase: 'incoming', muted: false, minimized: false, videoCall, remoteCam: videoCall });
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
          const pc = this.pc;
          pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
            .then(() => this.checkVideoAnswer(pc))
            .catch(() => this.finish('failed', 'Не удалось соединиться', 'failed'));
        }
        return mine;
      case 'media':
        if (mine && s!.phase !== 'ended' && s!.video) this.patch({ remoteCam: signal.cam, remoteScreen: signal.scr });
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

  /** The other side turned video off (or has no video): the camera button goes. */
  private checkVideoAnswer(pc: RTCPeerConnection): void {
    if (pc !== this.pc || !this.camSender) return;
    const channel = pc.getTransceivers().find((t) => t.sender === this.camSender);
    if (channel?.currentDirection === 'sendrecv') return;
    void this.camSender.replaceTrack(null).catch(() => {});
    this.camera?.getTracks().forEach((t) => t.stop());
    this.camera = null;
    this.camSender = this.screenSender = null;
    this.patch({ video: false, cam: false });
  }

  /** The answering side: the two video channels came with the offer, in the same order. */
  private takeVideoChannels(pc: RTCPeerConnection): void {
    const channels = pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video');
    if (!this.videoEnabled || channels.length < 2) {
      for (const t of channels) t.direction = 'inactive';
      return;
    }
    for (const t of channels.slice(0, 2)) t.direction = 'sendrecv';
    this.camSender = channels[0].sender;
    this.screenSender = channels[1].sender;
    this.patch({ video: true });
  }

  private async preparePeer(offering: boolean): Promise<RTCPeerConnection> {
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
    if (offering && this.videoEnabled) {
      this.camSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      this.screenSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      this.patch({ video: true });
    }
    pc.ontrack = (event) => {
      if (event.track.kind === 'video') {
        const slot = pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video').indexOf(event.transceiver);
        if (slot === 0) this.remoteCamera = new MediaStream([event.track]);
        else if (slot === 1) this.remoteDisplay = new MediaStream([event.track]);
        this.set(this.state && { ...this.state });
        return;
      }
      this.remote = new MediaStream([event.track]);
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
          this.patch({ phase: 'active', connectedAt: s.connectedAt ?? Date.now(), words: s.words ?? this.words(pc) });
          // In case the first `media` signal crossed the answer.
          if (!s.connectedAt && (s.cam || s.screen)) this.sendMedia();
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
    this.set({ ...s, phase: 'ended', endText, minimized: false, cam: false, screen: false, remoteCam: false, remoteScreen: false });
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
    this.camera?.getTracks().forEach((t) => t.stop());
    this.display?.getTracks().forEach((t) => t.stop());
    this.camera = this.display = null;
    this.camSender = this.screenSender = null;
    this.remote = this.remoteCamera = this.remoteDisplay = null;
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
