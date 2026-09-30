/**
 * The Reactor session state machine — a TypeScript port of
 * `crates/reactor-core/src/reactor.rs`, the Rust orchestrator every other
 * Reactor SDK shares (the browser reaches it through wasm; Swift, Python, C++
 * and Java through `reactor-ffi`).
 *
 * React Native cannot load that wasm — Hermes has no WebAssembly — and the
 * native `reactor-ffi` build ships its own libwebrtc, which would collide with
 * the one `react-native-webrtc` links. So the protocol is ported instead and
 * the media engine is `react-native-webrtc`: the only thing that was ever
 * platform-specific about the browser SDK was its `PeerTransport`.
 *
 * Structure follows the Rust file section by section, with the same names
 * where JavaScript allows, so a fix upstream has an obvious place to land
 * here. Where the Rust needs a mutex (the guard check and the status update
 * in one acquisition), this relies on JavaScript's run-to-completion: there
 * is no `await` between them.
 *
 * ```text
 * disconnected --connect()--> connecting --session created--> waiting
 *      ^                                                         |
 *      |                      peer connected + data & control    |
 *      |                      channels open                      v
 *      +---- disconnect() / fatal transport error ------------ ready
 * ```
 */
import { ReactorError } from '../errors';
import { Coordinator, Signaling } from './coordinator';
import {
  aborted,
  clipFailedCode,
  codes,
  coreError,
  decodeFailed,
  disconnected,
  invalidState,
  recordingError,
  requestFailed,
  timedOut,
  withOperation,
} from './errors';
import { AuthProvider, checkStatus, fetchHttpClient, type HttpClient, type JwtSource } from './http';
import {
  WebRTCPeerTransport,
  type MediaStreamLike,
  type MediaStreamTrackLike,
  type PeerConnectionLike,
  type PeerConnectionState,
  type PeerEvent,
  type PreparedOffer,
  type WebRTCImplementation,
} from './peer';
import {
  SDP_POLL,
  SESSION_POLL,
  sleep,
  type IceCandidate,
  type PollConfig,
  type ReactorStatus,
  type SessionResponse,
  type TrackCapability,
  type TrackMappingEntry,
  type WireCapabilities,
  type WireClip,
  type WireFileRef,
} from './protocol';
import {
  MessageKind,
  decodeControlServerMessage,
  decodeDataServerMessage,
  encodeControlClientMessage,
  encodeDataClientMessage,
  toJsonObject,
  type ClipReady,
  type ControlClientPayload,
  type ControlServerPayload,
  type DataServerPayload,
  type JsonObject,
  type ModelMessage,
} from './wire';

export const SDK_TYPE = 'react-native';

export interface ClientOptions {
  modelName: string;
  apiUrl?: string;
  local?: boolean;
  sdkType?: string;
  sdkVersion?: string;
  autoResumeTracks?: boolean;
  extraArgs?: Record<string, unknown>;
  heartbeatIntervalMs?: number;
  readyTimeoutMs?: number;
  controlRequestTimeoutMs?: number;
  clipRequestTimeoutMs?: number;
  maxSessionAttempts?: number;
  maxSdpAttempts?: number;
  sdpBackoffInitialMs?: number;
  sdpBackoffMaxMs?: number;
  sdpBackoffMultiplier?: number;
  /** Tracks known ahead of time: the SDP offer is built while the session
   *  poll is still in flight instead of after it. */
  modelTracks?: TrackCapability[];
}

export interface ConnectOptions {
  /** Adopt a session created elsewhere (e.g. by your backend). Adopters never
   *  terminate the session on disconnect. */
  sessionId?: string;
  /** Use a pre-registered WebRTC connection id. */
  connectionId?: number;
  autoResumeTracks?: boolean;
  /** SDP-answer poll attempt limit for this connection and its reconnects. */
  maxAttempts?: number;
}

export interface ClientDeps {
  webrtc: WebRTCImplementation;
  http?: HttpClient;
  /** Timer seam for tests. */
  wait?: (ms: number) => Promise<void>;
}

export interface WireMessage {
  type: string;
  data: unknown;
}

export interface ClientEvents {
  statusChanged: (status: ReactorStatus) => void;
  sessionIdChanged: (sessionId: string | undefined) => void;
  message: (message: WireMessage) => void;
  runtimeMessage: (message: WireMessage) => void;
  trackReceived: (name: string, mid: string | undefined) => void;
  error: (error: ReactorError) => void;
  capabilitiesReceived: (capabilities: WireCapabilities) => void;
}

/** Bytes to upload, as `upload_file` wants them: the body plus what the
 *  coordinator must be told about it up front. */
export interface UploadSource {
  body: Blob | ArrayBuffer | Uint8Array;
  size: number;
  name: string;
  mimeType: string;
}

// ── Request correlation (`control.rs`, `data.rs`) ───────────────────────────

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: ReactorError) => void;
  label: string;
}

class Correlator<T> {
  private counter = 0;
  private readonly pending = new Map<string, Pending<T>>();

  constructor(private readonly prefix: string) {}

  begin(label: string): { requestId: string; response: Promise<T> } {
    const requestId = `${this.prefix}_${++this.counter}`;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, label });
    });
    // A caller that stops awaiting (timeout) must not leave an unhandled
    // rejection behind when fail_all() rejects everything on disconnect.
    response.catch(() => {});
    return { requestId, response };
  }

  /** Resolves the request `requestId` answers; `false` if none was waiting. */
  resolve(requestId: string, value: T): boolean {
    if (!requestId) {
      return false;
    }
    const entry = this.pending.get(requestId);
    if (!entry) {
      console.warn(`[reactor] response for unknown request_id ${requestId}`);
      return false;
    }
    this.pending.delete(requestId);
    entry.resolve(value);
    return true;
  }

  cancel(requestId: string): void {
    this.pending.delete(requestId);
  }

  failAll(reason: string, error: (label: string, requestId: string) => ReactorError): void {
    const entries = [...this.pending];
    this.pending.clear();
    for (const [requestId, entry] of entries) {
      entry.reject(error(entry.label, `${reason} (request_id=${requestId})`));
    }
  }
}

// ── The client ──────────────────────────────────────────────────────────────

interface State {
  status: ReactorStatus;
  sessionId: string | undefined;
  sessionInfo: SessionResponse | undefined;
  createdSession: boolean;
  connectionId: number | undefined;
  capabilities: WireCapabilities | undefined;
  tracks: TrackCapability[];
  trackMapping: TrackMappingEntry[];
  lastError: ReactorError | undefined;
  peerConnected: boolean;
  dataOpen: boolean;
  controlOpen: boolean;
  readyGate: { resolve: () => void; reject: (error: ReactorError) => void } | undefined;
  iceBuffer: IceCandidate[];
  iceGatheringComplete: boolean;
  iceFinalSent: boolean;
  iceReady: boolean;
  pausedTracks: Set<string>;
  closing: boolean;
  teardownReason: PeerConnectionState | undefined;
  heartbeatEpoch: number;
  autoResumeTracks: boolean;
  sdpMaxAttempts: number;
}

function tracksMatch(a: TrackCapability[], b: TrackCapability[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  // Multiset equality: a preset [A, A] must not match real tracks [A, B].
  const remaining = [...b];
  for (const track of a) {
    const index = remaining.findIndex(
      (c) => c.name === track.name && c.kind === track.kind && c.direction === track.direction,
    );
    if (index === -1) {
      return false;
    }
    remaining.splice(index, 1);
  }
  return true;
}

function clipFromReady(ready: ClipReady, apiUrl: string): WireClip {
  const playlistUrl = /^https?:\/\//.test(ready.playlist_url)
    ? ready.playlist_url
    : `${apiUrl.replace(/\/+$/, '')}/${ready.playlist_url.replace(/^\/+/, '')}`;
  return {
    session_id: ready.session_id,
    kind: ready.kind,
    start_marker: ready.start_marker,
    end_marker: ready.end_marker,
    now_marker: ready.now_marker,
    predicted_ready_at_ms: ready.predicted_ready_at_ms,
    playlist_url: playlistUrl,
  };
}

function modelMessageValue(message: ModelMessage): WireMessage {
  return { type: message.type, data: message.data ?? null };
}

export class ReactorClient {
  private readonly options: Required<
    Pick<
      ClientOptions,
      | 'heartbeatIntervalMs'
      | 'readyTimeoutMs'
      | 'controlRequestTimeoutMs'
      | 'clipRequestTimeoutMs'
      | 'autoResumeTracks'
    >
  > & { modelTracks: TrackCapability[] | undefined; sdpPoll: PollConfig };
  private readonly http: HttpClient;
  private readonly auth: AuthProvider;
  private readonly coordinator: Coordinator;
  private readonly peer: WebRTCPeerTransport;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly control = new Correlator<ControlServerPayload>('ctrl');
  private readonly data = new Correlator<DataServerPayload | undefined>('data');
  private readonly listeners: { [K in keyof ClientEvents]?: ClientEvents[K] } = {};
  private freed = false;
  private readonly state: State;

  constructor(options: ClientOptions, jwt: JwtSource | null | undefined, deps: ClientDeps) {
    this.http = deps.http ?? fetchHttpClient;
    this.wait = deps.wait ?? sleep;
    this.auth = new AuthProvider(jwt ?? null);
    const sdpPoll: PollConfig = {
      initialMs: options.sdpBackoffInitialMs ?? SDP_POLL.initialMs,
      maxMs: options.sdpBackoffMaxMs ?? SDP_POLL.maxMs,
      multiplier: options.sdpBackoffMultiplier ?? SDP_POLL.multiplier,
      maxAttempts: options.maxSdpAttempts ?? SDP_POLL.maxAttempts,
    };
    this.options = {
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
      controlRequestTimeoutMs: options.controlRequestTimeoutMs ?? 10_000,
      clipRequestTimeoutMs: options.clipRequestTimeoutMs ?? 10_000,
      autoResumeTracks: options.autoResumeTracks ?? true,
      modelTracks: options.modelTracks,
      sdpPoll,
    };
    const local = options.local ?? false;
    this.coordinator = new Coordinator(
      this.http,
      this.auth,
      {
        apiUrl: options.apiUrl ?? (local ? 'http://localhost:8080' : 'https://api.reactor.inc'),
        modelName: options.modelName,
        clientInfo: { sdk_version: options.sdkVersion ?? '0.0.0', sdk_type: options.sdkType ?? SDK_TYPE },
        extraArgs: options.extraArgs,
        sessionPoll: { ...SESSION_POLL, maxAttempts: options.maxSessionAttempts ?? SESSION_POLL.maxAttempts },
        local,
      },
      this.wait,
    );
    this.peer = new WebRTCPeerTransport(deps.webrtc, (event) => {
      void this.handlePeerEvent(event);
    });
    this.state = {
      status: 'disconnected',
      sessionId: undefined,
      sessionInfo: undefined,
      createdSession: false,
      connectionId: undefined,
      capabilities: undefined,
      tracks: [],
      trackMapping: [],
      lastError: undefined,
      peerConnected: false,
      dataOpen: false,
      controlOpen: false,
      readyGate: undefined,
      iceBuffer: [],
      iceGatheringComplete: false,
      iceFinalSent: false,
      iceReady: false,
      pausedTracks: new Set(),
      closing: false,
      teardownReason: undefined,
      heartbeatEpoch: 0,
      autoResumeTracks: this.options.autoResumeTracks,
      sdpMaxAttempts: sdpPoll.maxAttempts,
    };
  }

  // ── Listeners (the wasm binding's `on*` surface) ──────────────────────────

  on<K extends keyof ClientEvents>(event: K, listener: ClientEvents[K]): void {
    this.listeners[event] = listener as never;
  }

  private dispatch<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
    if (this.freed) {
      return;
    }
    const listener = this.listeners[event] as ((...a: Parameters<ClientEvents[K]>) => void) | undefined;
    if (!listener) {
      return;
    }
    try {
      listener(...args);
    } catch (error) {
      // Application code running on our event loop; it must not take the
      // session down with it.
      console.error('[reactor] event listener threw:', error);
    }
  }

  setJwt(jwt: JwtSource | null | undefined): void {
    this.auth.set(jwt);
  }

  get jwtSource(): JwtSource | null {
    return this.auth.current;
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  status(): ReactorStatus {
    return this.state.status;
  }
  sessionId(): string | undefined {
    return this.state.sessionId;
  }
  sessionInfo(): SessionResponse | undefined {
    return this.state.sessionInfo;
  }
  capabilities(): WireCapabilities | undefined {
    return this.state.capabilities;
  }
  lastError(): ReactorError | undefined {
    return this.state.lastError;
  }
  tracks(): TrackCapability[] {
    return [...this.state.tracks];
  }
  trackMapping(): TrackMappingEntry[] {
    return [...this.state.trackMapping];
  }
  pausedTracks(): string[] {
    return [...this.state.pausedTracks];
  }

  getPeerConnection(): PeerConnectionLike | undefined {
    return this.peer.peerConnection;
  }
  getTrackByMid(mid: string): MediaStreamTrackLike | undefined {
    return this.peer.receivedTrack(mid)?.track;
  }
  getStreamByMid(mid: string): MediaStreamLike | undefined {
    return this.peer.receivedTrack(mid)?.stream;
  }
  getTrackByName(name: string): MediaStreamTrackLike | undefined {
    const mid = this.midOf(name);
    return mid === undefined ? undefined : this.getTrackByMid(mid);
  }
  getStreamByName(name: string): MediaStreamLike | undefined {
    const mid = this.midOf(name);
    return mid === undefined ? undefined : this.getStreamByMid(mid);
  }

  private midOf(name: string): string | undefined {
    return this.state.trackMapping.find((entry) => entry.name === name)?.mid;
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  async connect(options: ConnectOptions = {}): Promise<void> {
    const s = this.state;
    if (s.status !== 'disconnected') {
      throw withOperation(invalidState(`connect() while status is ${s.status}`), 'connect');
    }
    // Guard and update with no await between them.
    s.closing = false;
    s.teardownReason = undefined;
    s.status = 'connecting';
    s.heartbeatEpoch++;
    if (options.autoResumeTracks !== undefined) {
      s.autoResumeTracks = options.autoResumeTracks;
    }
    if (options.maxAttempts !== undefined) {
      s.sdpMaxAttempts = options.maxAttempts;
    }
    this.dispatch('statusChanged', 'connecting');
    try {
      await this.connectInner(options);
    } catch (cause) {
      const error = withOperation(this.asReactorError(cause), 'connect');
      this.emitError(error);
      await this.teardown(false, true);
      throw error;
    }
    this.startHeartbeat();
  }

  private async connectInner(options: ConnectOptions): Promise<void> {
    let sessionId: string;
    if (options.sessionId !== undefined) {
      sessionId = options.sessionId;
      this.state.sessionId = sessionId;
      this.state.createdSession = false;
    } else {
      const created = await this.coordinator.createSession();
      sessionId = created.session_id;
      this.state.sessionId = sessionId;
      this.state.createdSession = true;
      this.state.sessionInfo = created;
    }
    this.dispatch('sessionIdChanged', sessionId);
    this.setStatus('waiting');

    const preset = this.options.modelTracks;
    if (preset) {
      // Build the offer while the readiness poll is still in flight.
      const signaling = this.signaling(sessionId);
      const [sessionResult, preparedResult] = await Promise.allSettled([
        this.coordinator.pollSessionReady(sessionId),
        signaling.iceServers().then((ice) => this.peer.prepare(ice, preset)),
      ]);
      if (sessionResult.status === 'rejected') {
        if (preparedResult.status === 'fulfilled') await this.peer.close();
        throw sessionResult.reason;
      }
      const session = sessionResult.value;
      const capabilities = session.capabilities;
      if (!capabilities) {
        throw decodeFailed('ready session missing capabilities');
      }
      if (!tracksMatch(capabilities.tracks, preset)) {
        if (preparedResult.status === 'fulfilled') await this.peer.close();
        throw coreError(
          codes.BAD_REQUEST,
          `preset tracks ${JSON.stringify(preset)} do not match the session's real tracks ${JSON.stringify(
            capabilities.tracks,
          )}`,
        );
      }
      if (preparedResult.status === 'rejected') {
        throw preparedResult.reason;
      }
      this.acceptSession(session, capabilities);
      await this.finishTransport(sessionId, false, options.connectionId, preparedResult.value);
    } else {
      const session = await this.coordinator.pollSessionReady(sessionId);
      const capabilities = session.capabilities;
      if (!capabilities) {
        throw decodeFailed('ready session missing capabilities');
      }
      this.acceptSession(session, capabilities);
      await this.establishTransport(sessionId, false, options.connectionId);
    }

    this.setStatus('ready');
    if (this.state.autoResumeTracks) {
      await this.autoResumeRecvTracks();
    }
  }

  private acceptSession(session: SessionResponse, capabilities: WireCapabilities): void {
    this.state.tracks = [...capabilities.tracks];
    this.state.capabilities = capabilities;
    this.state.sessionInfo = session;
    this.dispatch('capabilitiesReceived', capabilities);
  }

  /** Rebuild the transport on the same session, without ending it. */
  async reconnect(options: ConnectOptions = {}): Promise<void> {
    if (this.state.status === 'ready') {
      // Recoverable: keep the session this reconnect is about to reuse.
      await this.teardown(true, false);
    }
    const s = this.state;
    if (s.sessionId === undefined) {
      throw withOperation(invalidState('reconnect() without a session'), 'reconnect');
    }
    const sessionId = s.sessionId;
    if (options.maxAttempts !== undefined) {
      s.sdpMaxAttempts = options.maxAttempts;
    }
    s.closing = false;
    s.teardownReason = undefined;
    s.peerConnected = false;
    s.dataOpen = false;
    s.controlOpen = false;
    s.iceBuffer = [];
    s.iceGatheringComplete = false;
    s.iceFinalSent = false;
    s.iceReady = false;
    s.status = 'connecting';
    s.heartbeatEpoch++;
    this.dispatch('statusChanged', 'connecting');
    this.setStatus('waiting');
    try {
      await this.establishTransport(sessionId, true, undefined);
    } catch (cause) {
      const error = withOperation(this.asReactorError(cause), 'reconnect');
      this.emitError(error);
      await this.teardown(true, true);
      throw error;
    }
    this.setStatus('ready');
    if (this.state.autoResumeTracks) {
      await this.autoResumeRecvTracks();
    }
    this.startHeartbeat();
  }

  /** Tear down the transport and end the session server-side — unless this
   *  client only adopted it. */
  async disconnect(): Promise<void> {
    await this.teardown(false, false);
  }

  private async establishTransport(
    sessionId: string,
    reconnect: boolean,
    adoptConnectionId: number | undefined,
  ): Promise<void> {
    const signaling = this.signaling(sessionId);
    const iceServers = await signaling.iceServers();
    const prepared = await this.peer.prepare(iceServers, this.state.tracks);
    await this.finishTransport(sessionId, reconnect, adoptConnectionId, prepared);
  }

  private async finishTransport(
    sessionId: string,
    reconnect: boolean,
    adoptConnectionId: number | undefined,
    prepared: PreparedOffer,
  ): Promise<void> {
    const signaling = this.signaling(sessionId);
    const gate = new Promise<void>((resolve, reject) => {
      this.state.readyGate = { resolve, reject };
    });
    gate.catch(() => {});
    this.checkReady();
    this.state.trackMapping = [...prepared.trackMapping];

    const existing = this.state.connectionId;
    let connectionId: number;
    if (adoptConnectionId !== undefined) {
      connectionId = adoptConnectionId;
    } else if (reconnect && existing !== undefined) {
      connectionId = existing;
    } else {
      connectionId = await signaling.registerConnection();
    }
    const replaceSdp = reconnect && adoptConnectionId === undefined && existing !== undefined;
    this.state.connectionId = connectionId;
    this.state.iceReady = true;
    await this.flushIce(signaling);

    await signaling.sendSdpOffer(connectionId, prepared.sdpOffer, prepared.trackMapping, replaceSdp);
    const answer = await signaling.pollSdpAnswer(connectionId);
    if (answer.connection_id !== undefined && answer.connection_id !== null) {
      this.state.connectionId = answer.connection_id;
    }

    // A peer failure can close the transport under us at any point here
    // (REA-5659); prefer the recorded reason over whatever calling into a
    // closed transport says.
    const early = this.teardownError();
    if (early) {
      throw early;
    }
    try {
      await this.peer.setRemoteDescription(answer.sdp_answer);
    } catch (cause) {
      throw this.teardownError() ?? cause;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(timedOut(`transport readiness did not complete within ${this.options.readyTimeoutMs}ms`)),
        this.options.readyTimeoutMs,
      );
    });
    try {
      await Promise.race([gate, timeout]);
    } catch (cause) {
      if ((cause as ReactorError)?.code === codes.ABORTED) {
        throw this.teardownError() ?? cause;
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }

  private teardownError(): ReactorError | undefined {
    const reason = this.state.teardownReason;
    return reason === undefined ? undefined : disconnected(`peer connection state: ${reason}`);
  }

  private async teardown(recoverable: boolean, alreadyFailing: boolean): Promise<void> {
    const s = this.state;
    s.closing = true;
    const gate = s.readyGate;
    s.readyGate = undefined;
    gate?.reject(aborted());
    const terminate = !recoverable && s.createdSession;
    const sessionId = s.sessionId;

    this.control.failAll('disconnected', (label, message) =>
      coreError(codes.DISCONNECTED, `control request '${label}' failed (${codes.DISCONNECTED}): ${message}`),
    );
    this.data.failAll('disconnected', (label, message) =>
      coreError(codes.DISCONNECTED, `command '${label}' failed (${codes.DISCONNECTED}): ${message}`),
    );
    await this.peer.close();

    if (terminate && sessionId !== undefined) {
      try {
        await this.coordinator.terminateSession(sessionId);
      } catch (error) {
        console.warn('[reactor] session termination failed:', error);
      }
    }

    s.peerConnected = false;
    s.dataOpen = false;
    s.controlOpen = false;
    s.iceBuffer = [];
    s.iceGatheringComplete = false;
    s.iceFinalSent = false;
    s.iceReady = false;
    s.trackMapping = [];
    s.pausedTracks.clear();
    let sessionCleared = false;
    if (!recoverable) {
      s.sessionId = undefined;
      s.sessionInfo = undefined;
      s.createdSession = false;
      s.connectionId = undefined;
      s.capabilities = undefined;
      s.tracks = [];
      sessionCleared = true;
    }
    this.setStatus('disconnected');
    if (sessionCleared && !alreadyFailing) {
      this.dispatch('sessionIdChanged', undefined);
    }
  }

  // ── Peer event intake ─────────────────────────────────────────────────────

  private async handlePeerEvent(event: PeerEvent): Promise<void> {
    const s = this.state;
    switch (event.type) {
      case 'connectionState':
        await this.onPeerConnectionState(event.state);
        return;
      case 'dataChannelOpen':
        s.dataOpen = true;
        this.checkReady();
        return;
      case 'controlChannelOpen':
        s.controlOpen = true;
        this.checkReady();
        return;
      case 'dataMessage':
        this.onDataMessage(event.bytes);
        return;
      case 'controlMessage':
        this.onControlMessage(event.bytes);
        return;
      case 'trackReceived': {
        const name = s.trackMapping.find((entry) => entry.mid === event.mid)?.name;
        if (name === undefined) {
          console.warn(`[reactor] received track with unknown mid ${String(event.mid)}`);
          return;
        }
        this.dispatch('trackReceived', name, event.mid);
        return;
      }
      case 'iceCandidate':
        s.iceBuffer.push(event.candidate);
        if (s.iceReady) await this.flushIceCurrentSession();
        return;
      case 'iceGatheringComplete':
        s.iceGatheringComplete = true;
        if (s.iceReady) await this.flushIceCurrentSession();
        return;
    }
  }

  private async onPeerConnectionState(state: PeerConnectionState): Promise<void> {
    const s = this.state;
    if (state === 'connected') {
      s.peerConnected = true;
      this.checkReady();
      return;
    }
    if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      if (!s.closing && s.status !== 'disconnected') {
        this.emitError(
          coreError(codes.DISCONNECTED, `connection disconnected: peer connection state: ${state}`),
        );
        // Recorded before teardown sets `closing`, so a negotiation still in
        // flight reports the real reason.
        s.teardownReason = state;
        await this.teardown(true, true);
      }
    }
  }

  private checkReady(): void {
    const s = this.state;
    if (s.peerConnected && s.dataOpen && s.controlOpen && s.readyGate) {
      const gate = s.readyGate;
      s.readyGate = undefined;
      gate.resolve();
    }
  }

  private onDataMessage(bytes: Uint8Array): void {
    let message;
    try {
      message = decodeDataServerMessage(bytes);
    } catch (error) {
      console.warn('[reactor] unparseable data message:', error);
      return;
    }
    // A bodyless ack still resolves its command (as `undefined`).
    const correlated = this.data.resolve(message.request_id, message.payload);
    const payload = message.payload;
    if (!payload) {
      return;
    }
    if (payload.case === 'message') {
      // A correlated reply is broadcast as well: listeners see it alongside
      // the resolved call.
      this.dispatch('message', modelMessageValue(payload.value));
    } else if (!correlated) {
      // A correlated error already reached its caller.
      this.emitError(coreError(payload.value.code || codes.INTERNAL_ERROR, payload.value.message));
    }
  }

  private onControlMessage(bytes: Uint8Array): void {
    let message;
    try {
      message = decodeControlServerMessage(bytes);
    } catch (error) {
      console.warn('[reactor] unparseable control message:', error);
      return;
    }
    const payload = message.payload;
    if (!payload) {
      return;
    }
    this.control.resolve(message.request_id, payload);
    switch (payload.case) {
      case 'clip_ready':
        this.dispatch('runtimeMessage', {
          type: 'clipReady',
          data: clipFromReady(payload.value, this.coordinator.apiUrl),
        });
        break;
      case 'clip_failed':
        this.dispatch('runtimeMessage', { type: 'clipFailed', data: { reason: payload.value.reason } });
        break;
      case 'moderation':
        this.dispatch('runtimeMessage', { type: 'moderation', data: { ...payload.value } });
        break;
      default:
        break;
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  async sendCommand(
    command: string,
    data: Record<string, unknown> | undefined,
    uploads: Record<string, WireFileRef> | undefined,
  ): Promise<WireMessage | undefined> {
    this.ensureReady('sendCommand');
    let json: JsonObject;
    try {
      json = toJsonObject(data ?? {});
    } catch (cause) {
      throw withOperation(decodeFailed(`command data must be a JSON object: ${String(cause)}`), 'sendCommand');
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw withOperation(decodeFailed('command data must be a JSON object'), 'sendCommand');
    }
    const { requestId, response } = this.data.begin(command);
    const bytes = encodeDataClientMessage({
      request_id: requestId,
      kind: MessageKind.Request,
      payload: {
        case: 'command',
        value: { type: command, data: json, uploads: { ...(uploads ?? {}) } },
      },
    });
    const max = this.peer.maxMessageBytes();
    if (bytes.length > max) {
      this.data.cancel(requestId);
      throw withOperation(
        coreError(codes.MESSAGE_TOO_LARGE, `message too large: ${bytes.length} bytes exceeds ${max}`),
        'sendCommand',
      );
    }
    try {
      this.peer.sendData(bytes);
    } catch (cause) {
      this.data.cancel(requestId);
      const error = withOperation(this.asReactorError(cause), 'send_command');
      this.emitError(error);
      throw error;
    }
    const reply = await this.withTimeout(response, this.options.controlRequestTimeoutMs, command, () =>
      this.data.cancel(requestId),
    );
    if (reply === undefined) {
      return undefined;
    }
    if (reply.case === 'message') {
      return modelMessageValue(reply.value);
    }
    throw withOperation(requestFailed('command', command, reply.value.code, reply.value.message), 'sendCommand');
  }

  async requestSchema(): Promise<unknown> {
    this.ensureReady('requestSchema');
    const payload = await this.controlRequest(
      'request_schema',
      { case: 'request_schema' },
      this.options.controlRequestTimeoutMs,
    );
    if (payload.case === 'model_schema') {
      return payload.value.openapi ?? null;
    }
    if (payload.case === 'error') {
      throw requestFailed('control', 'request_schema', payload.value.code, payload.value.message);
    }
    throw decodeFailed('unexpected control response for request_schema');
  }

  private ping(): void {
    this.peer.sendControl(
      encodeControlClientMessage({ request_id: '', kind: MessageKind.Notification, payload: { case: 'ping' } }),
    );
  }

  private notify(payload: ControlClientPayload): void {
    this.peer.sendControl(encodeControlClientMessage({ request_id: '', kind: MessageKind.Notification, payload }));
  }

  private async controlRequest(
    method: string,
    payload: ControlClientPayload,
    timeoutMs: number,
  ): Promise<ControlServerPayload> {
    const { requestId, response } = this.control.begin(method);
    try {
      this.peer.sendControl(encodeControlClientMessage({ request_id: requestId, kind: MessageKind.Request, payload }));
    } catch (cause) {
      this.control.cancel(requestId);
      throw cause;
    }
    return this.withTimeout(response, timeoutMs, method, () => this.control.cancel(requestId));
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, what: string, onTimeout: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(timedOut(`${what} did not complete within ${ms}ms`));
      }, ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Tracks ────────────────────────────────────────────────────────────────

  /** Claim the slot first (a control round-trip): media on a track the
   *  runtime has not accepted would go into a void. */
  async publishTrack(name: string, track: MediaStreamTrackLike): Promise<void> {
    this.ensureReady('publishTrack');
    let payload: ControlServerPayload;
    try {
      payload = await this.controlRequest(
        'publish_track',
        { case: 'publish_track', value: { name } },
        this.options.controlRequestTimeoutMs,
      );
    } catch (cause) {
      const error = withOperation(this.asReactorError(cause), 'publish_track');
      this.emitError(error);
      throw withOperation(error, 'publishTrack');
    }
    if (payload.case === 'error') {
      const error = requestFailed('control', 'publish_track', payload.value.code, payload.value.message);
      this.emitError(withOperation(error, 'publish_track'));
      throw withOperation(error, 'publishTrack');
    }
    if (payload.case !== 'publish_track') {
      throw withOperation(decodeFailed('unexpected control response for publish_track'), 'publishTrack');
    }
    try {
      await this.peer.replaceSenderTrack(name, track);
    } catch (cause) {
      throw withOperation(this.asReactorError(cause), 'publishTrack');
    }
  }

  async unpublishTrack(name: string): Promise<void> {
    this.ensureReady('unpublishTrack');
    try {
      this.notify({ case: 'unpublish_track', value: { name } });
      await this.peer.replaceSenderTrack(name, null);
    } catch (cause) {
      throw withOperation(this.asReactorError(cause), 'unpublishTrack');
    }
  }

  async pauseTrack(name: string): Promise<void> {
    this.ensureReady('pauseTrack');
    try {
      await this.peer.setTrackDirection(name, false);
      this.notify({ case: 'pause_track', value: { name } });
    } catch (cause) {
      throw withOperation(this.asReactorError(cause), 'pauseTrack');
    }
    this.state.pausedTracks.add(name);
  }

  async resumeTrack(name: string): Promise<void> {
    this.ensureReady('resumeTrack');
    try {
      await this.peer.setTrackDirection(name, true);
      this.notify({ case: 'resume_track', value: { name } });
    } catch (cause) {
      throw withOperation(this.asReactorError(cause), 'resumeTrack');
    }
    this.state.pausedTracks.delete(name);
  }

  async setTrackBitrate(name: string, minBps: number | undefined, maxBps: number | undefined): Promise<void> {
    const bound = (v: number | undefined) => (v !== undefined && v >= 0 ? v : undefined);
    const declared = this.state.tracks;
    if (declared.length > 0 && !declared.some((t) => t.name === name)) {
      throw withOperation(
        invalidState(`unknown track ${JSON.stringify(name)}; this session declares: ${declared.map((t) => t.name).join(', ')}`),
        'setTrackBitrate',
      );
    }
    try {
      await this.peer.setTrackBitrate(name, bound(minBps), bound(maxBps));
    } catch (cause) {
      throw withOperation(this.asReactorError(cause), 'setTrackBitrate');
    }
  }

  private async autoResumeRecvTracks(): Promise<void> {
    const recv = this.state.tracks.filter((t) => t.direction === 'recvonly').map((t) => t.name);
    for (const name of recv) {
      try {
        await this.resumeTrack(name);
      } catch (error) {
        console.warn(`[reactor] auto-resume of track '${name}' failed:`, error);
      }
    }
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  async requestClip(durationSeconds: number): Promise<WireClip> {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw withOperation(
        recordingError(codes.BAD_REQUEST, 'duration_seconds must be a positive finite number'),
        'requestClip',
      );
    }
    return this.dispatchClipRequest('requestClip', {
      case: 'request_clip',
      value: { duration_seconds: durationSeconds },
    });
  }

  async requestRecording(): Promise<WireClip> {
    return this.dispatchClipRequest('requestRecording', { case: 'request_recording' });
  }

  private async dispatchClipRequest(method: string, payload: ControlClientPayload): Promise<WireClip> {
    if (this.state.status !== 'ready') {
      throw withOperation(
        recordingError(codes.INVALID_STATE, `cannot request clip while status is ${this.state.status}`),
        method,
      );
    }
    let response: ControlServerPayload;
    try {
      response = await this.controlRequest(method, payload, this.options.clipRequestTimeoutMs);
    } catch (cause) {
      const error = this.asReactorError(cause);
      if (error.code === codes.REQUEST_TIMEOUT) {
        throw withOperation(recordingError(codes.REQUEST_TIMEOUT, 'clip request timed out'), method);
      }
      throw withOperation(error, method);
    }
    switch (response.case) {
      case 'clip_ready':
        return clipFromReady(response.value, this.coordinator.apiUrl);
      case 'clip_failed':
        throw withOperation(recordingError(clipFailedCode(response.value.reason), response.value.reason), method);
      case 'error':
        throw withOperation(recordingError(response.value.code, response.value.message), method);
      default:
        throw withOperation(decodeFailed(`unexpected control response for ${method}`), method);
    }
  }

  // ── Uploads ───────────────────────────────────────────────────────────────

  async uploadFile(source: UploadSource): Promise<WireFileRef> {
    this.ensureReady('uploadFile');
    const sessionId = this.state.sessionId;
    if (sessionId === undefined) {
      throw withOperation(invalidState('upload_file() without a session'), 'uploadFile');
    }
    if (source.size === 0) {
      throw withOperation(invalidState('upload_file() called with an empty file'), 'uploadFile');
    }
    try {
      const upload = await this.coordinator.createUpload(sessionId, {
        name: source.name,
        size: source.size,
        mime_type: source.mimeType,
      });
      const response = await this.http({
        method: 'PUT',
        url: upload.presigned_url,
        headers: { 'Content-Type': source.mimeType },
        body: source.body,
      });
      await checkStatus(response, 'presigned upload');
      const fileRef: WireFileRef = {
        upload_id: upload.presigned_id,
        name: source.name,
        mime_type: source.mimeType,
        size: source.size,
      };
      if (this.state.status === 'ready') {
        try {
          this.notify({ case: 'file_uploaded', value: { ...fileRef } });
        } catch {
          // The upload itself succeeded; the notification is advisory.
        }
      }
      return fileRef;
    } catch (cause) {
      throw withOperation(this.asReactorError(cause), 'uploadFile');
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  /** Keep-alive while ready. Must stay well under the runtime's own liveness
   *  timeout (20s by default). Exits on its own when the connection ends or
   *  another connect starts. */
  private startHeartbeat(): void {
    const interval = this.options.heartbeatIntervalMs;
    if (interval <= 0) {
      return;
    }
    const epoch = this.state.heartbeatEpoch;
    const loop = async () => {
      for (;;) {
        const s = this.state;
        if (this.freed || s.heartbeatEpoch !== epoch || s.closing || s.status !== 'ready') {
          return;
        }
        try {
          this.ping();
        } catch (error) {
          if ((error as ReactorError)?.code !== codes.INVALID_STATE) {
            console.warn('[reactor] heartbeat ping failed:', error);
          }
        }
        await this.wait(interval);
      }
    };
    void loop();
  }

  // ── ICE ───────────────────────────────────────────────────────────────────

  private signaling(sessionId: string): Signaling {
    return new Signaling(
      this.http,
      this.auth,
      this.coordinator.transportBaseUrl(sessionId),
      this.coordinator.clientInfo,
      { ...this.options.sdpPoll, maxAttempts: this.state.sdpMaxAttempts },
      this.wait,
    );
  }

  private async flushIceCurrentSession(): Promise<void> {
    const sessionId = this.state.sessionId;
    if (sessionId !== undefined) {
      await this.flushIce(this.signaling(sessionId));
    }
  }

  private async flushIce(signaling: Signaling): Promise<void> {
    const s = this.state;
    const connectionId = s.connectionId;
    if (connectionId === undefined || !s.iceReady) {
      return;
    }
    const candidates = s.iceBuffer;
    s.iceBuffer = [];
    const isFinal = s.iceGatheringComplete && !s.iceFinalSent;
    if (candidates.length === 0 && !isFinal) {
      return;
    }
    if (isFinal) {
      s.iceFinalSent = true;
    }
    try {
      await signaling.sendIceCandidates(connectionId, candidates, isFinal);
    } catch (error) {
      console.warn('[reactor] failed to send ICE candidates:', error);
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private ensureReady(operation: string): void {
    const status = this.state.status;
    if (status !== 'ready') {
      throw withOperation(invalidState(`operation requires ready status, currently ${status}`), operation);
    }
  }

  private setStatus(status: ReactorStatus): void {
    if (this.state.status === status) {
      return;
    }
    this.state.status = status;
    this.dispatch('statusChanged', status);
  }

  private emitError(error: ReactorError): void {
    this.state.lastError = error;
    this.dispatch('error', error);
  }

  private asReactorError(cause: unknown): ReactorError {
    if (cause instanceof ReactorError) {
      return cause;
    }
    return coreError(codes.INTERNAL_ERROR, cause instanceof Error ? cause.message : String(cause));
  }

  /** Release local resources: stops the heartbeat and closes the peer
   *  connection. Ending the *session* is `disconnect()`'s job. */
  free(): void {
    this.freed = true;
    this.state.heartbeatEpoch++;
    void this.peer.close();
  }
}
