/**
 * `Reactor` — the same class, methods and events as `@reactor-team/js-sdk`'s
 * `Reactor`, for React Native.
 *
 * Mirrors `sdks/js/src/reactor.ts` method for method. What changed is only
 * what sits underneath: the browser SDK drives a wasm build of the Rust core;
 * this drives `core/client.ts`, a TypeScript port of the same core, over
 * `react-native-webrtc`. The serialization rules (the lifecycle queue, the
 * reader/writer exclusion), the never-rejecting `sendCommand`, the schema
 * fetched on every "ready", the 2-second stats poll — all carried over as is.
 */
import { ReactorError, toReactorError } from './errors';
import { FileRef } from './file-ref';
import { ReactorClient, type ClientDeps } from './core/client';
import { Emitter } from './core/emitter';
import { extractFileRefs, toPublicFileRef } from './core/file-refs';
import { createRTCStatsExtractor, STATS_INTERVAL_MS } from './core/stats';
import type { MediaStreamTrackLike } from './core/peer';
import type { WireCapabilities, WireClip } from './core/protocol';
import { reactNativeWebRTC } from './platform/webrtc';
import { downloadClip, type DownloadClipOptions } from './recording';
import type {
  Capabilities,
  Clip,
  ClipKind,
  ConnectionStats,
  ConnectionTimings,
  ConnectOptions,
  JwtSource,
  MediaStream,
  MediaStreamTrack,
  MessageScope,
  ModelSchema,
  NotFunction,
  ReactorEventMap,
  ReactorMessage,
  ReactorOptions,
  ReactorStatus,
  RTCPeerConnection,
  SessionResponse,
  TrackCapability,
  TrackMappingEntry,
  UploadInput,
} from './types';

export const SDK_VERSION = '0.1.0';

/** `Symbol.dispose` where the engine has it (Hermes may not), so
 *  `using reactor = new Reactor(…)` works wherever the syntax does. */
const disposeSymbol: symbol =
  (Symbol as unknown as { dispose?: symbol }).dispose ?? Symbol.for('Symbol.dispose');

/** A minimal serial queue — `awaitqueue`'s one behavior this class uses. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  push<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

function toPublicCapabilities(wire: WireCapabilities): Capabilities {
  const capabilities: Capabilities = { protocolVersion: wire.protocol_version, tracks: wire.tracks };
  if (wire.commands !== undefined) capabilities.commands = wire.commands;
  if (wire.emission_fps !== undefined) capabilities.emissionFps = wire.emission_fps;
  return capabilities;
}

function toPublicClip(clip: WireClip): Clip {
  return {
    sessionId: clip.session_id,
    kind: clip.kind as ClipKind,
    startMarker: clip.start_marker,
    endMarker: clip.end_marker,
    nowMarker: clip.now_marker,
    predictedReadyAtMs: clip.predicted_ready_at_ms,
    playlistUrl: clip.playlist_url,
  };
}

const now = () => globalThis.performance?.now?.() ?? Date.now();

/**
 * A live connection to a Reactor model.
 */
export class Reactor {
  private readonly clientOptions: Omit<ReactorOptions, 'jwt'>;
  private jwt: JwtSource | null | undefined;
  private client: ReactorClient | undefined;
  private disposed = false;
  private _lastError: ReactorError | undefined;
  private schema: ModelSchema | undefined;
  private schemaRefreshId = 0;
  private capabilities: Capabilities | undefined;

  private stats: ConnectionStats | undefined;
  private connectionTimings: ConnectionTimings | undefined;
  private statsPollHandle: ReturnType<typeof setInterval> | undefined;
  private statsPollGeneration = 0;
  private connectStartTime: number | undefined;
  private waitingStartTime: number | undefined;

  private readonly emitter = new Emitter<ReactorEventMap>();
  /** Serializes connect()/reconnect()/disconnect() and the track operations
   *  against each other, as the JS SDK does. */
  private readonly queue = new SerialQueue();
  private readonly activeReads = new Set<Promise<unknown>>();
  private writerActive = false;
  private writerIdleWaiters: Array<() => void> = [];

  /**
   * @param deps Advanced: replace the WebRTC engine or the HTTP client (a
   *   custom `fetch` with certificate pinning, a test double). Defaults to
   *   `react-native-webrtc` and the global `fetch`.
   */
  constructor(
    options: ReactorOptions,
    private readonly deps: Partial<ClientDeps> = {},
  ) {
    const { jwt, ...clientOptions } = options;
    this.clientOptions = { sdkVersion: SDK_VERSION, ...clientOptions };
    this.jwt = jwt ?? null;
  }

  private async withReaderAccess<T>(fn: () => Promise<T>): Promise<T> {
    while (this.writerActive) {
      await new Promise<void>((resolve) => this.writerIdleWaiters.push(resolve));
    }
    const result = fn();
    const tracked = result.catch(() => undefined);
    this.activeReads.add(tracked);
    try {
      return await result;
    } finally {
      this.activeReads.delete(tracked);
    }
  }

  private async withWriterAccess<T>(fn: () => Promise<T>): Promise<T> {
    this.writerActive = true;
    if (this.activeReads.size > 0) {
      await Promise.all(this.activeReads);
    }
    try {
      return await fn();
    } finally {
      this.writerActive = false;
      const waiters = this.writerIdleWaiters;
      this.writerIdleWaiters = [];
      for (const wake of waiters) wake();
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * `jwt`, when given, replaces whatever `new Reactor({ jwt })` was given.
   * Throws if already connected or connecting; call `disconnect()` first.
   */
  async connect(jwt?: JwtSource, options?: ConnectOptions): Promise<void> {
    this.assertNotDisposed();
    try {
      if (this.getStatus() !== 'disconnected') {
        throw new Error('Already connected or connecting.');
      }
      if (jwt !== undefined) {
        this.jwt = jwt;
        this.client?.setJwt(jwt);
      }
      await this.queue.push(() =>
        this.withWriterAccess(async () => {
          await this.getOrCreateClient().connect(options);
        }),
      );
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  /**
   * Ends the connection, and the session with it when this instance created
   * it. `recoverable: true` keeps the local client around so a later
   * `connect()`/`reconnect()` reuses it.
   */
  async disconnect(recoverable = false): Promise<void> {
    this.assertNotDisposed();
    try {
      await this.queue.push(() =>
        this.withWriterAccess(async () => {
          if (this.client) {
            await this.client.disconnect();
          }
          this.resetConnectionState();
          if (!recoverable) {
            this.freeClient();
          }
        }),
      );
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  /** Rebuilds the transport on the current session. Only
   *  `options.maxAttempts` applies. */
  async reconnect(options?: ConnectOptions): Promise<void> {
    this.assertNotDisposed();
    try {
      await this.queue.push(() =>
        this.withWriterAccess(async () => {
          const reconnectOptions: ConnectOptions = {};
          if (options?.maxAttempts !== undefined) reconnectOptions.maxAttempts = options.maxAttempts;
          await this.getOrCreateClient().reconnect(reconnectOptions);
        }),
      );
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  // ── Messaging ───────────────────────────────────────────────────────────

  /**
   * Sends a command to the model and resolves with its correlated reply —
   * `undefined` when the handler acknowledged without a body.
   *
   * Never rejects: a failure is reported through `getLastError()` and the
   * `error` event, resolving `undefined`, exactly as the JS SDK does, so a
   * fire-and-forget `sendCommand(...)` never becomes an unhandled rejection.
   *
   * A `FileRef` from `uploadFile()` may be passed anywhere in `data`.
   */
  async sendCommand<T extends object = Record<string, unknown>>(
    command: string,
    data?: NotFunction<T>,
    scope?: MessageScope,
  ): Promise<ReactorMessage | undefined> {
    if (scope === 'runtime') {
      return this.sendRuntimeScopedCommand(command, data);
    }
    try {
      this.assertNotDisposed();
      const extracted = extractFileRefs(data as Record<string, unknown> | undefined);
      const reply = await this.withReaderAccess(async () =>
        this.getOrCreateClient().sendCommand(command, extracted.data, extracted.uploads),
      );
      return reply ?? undefined;
    } catch (cause) {
      this.emitError(cause);
      return undefined;
    }
  }

  private async sendRuntimeScopedCommand(command: string, data?: object): Promise<ReactorMessage | undefined> {
    switch (command) {
      case 'requestSchema':
        try {
          await this.withReaderAccess(async () => this.refreshSchema(this.getOrCreateClient()));
        } catch (cause) {
          this.emitError(cause);
        }
        return undefined;
      case 'requestCapabilities':
        return undefined;
      default:
        console.warn(
          `[Reactor] sendCommand(${JSON.stringify(command)}, …, "runtime") has no runtime-scope destination in this SDK — sending as a normal application-scope command instead.`,
        );
        return this.sendCommand(command, data as NotFunction<object>);
    }
  }

  /** Requests the model's command schema directly. It is already fetched on
   *  every "ready" — see `getSchema()`. */
  async requestSchema(): Promise<ModelSchema | undefined> {
    this.assertNotDisposed();
    try {
      return await this.withReaderAccess(async () =>
        this.normalizeSchema(await this.getOrCreateClient().requestSchema()),
      );
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  getSchema(): ModelSchema | undefined {
    return this.schema;
  }

  getCapabilities(): Capabilities | undefined {
    return this.capabilities;
  }

  getSessionInfo(): SessionResponse | undefined {
    return this.client?.sessionInfo();
  }

  // ── Tracks ──────────────────────────────────────────────────────────────

  /** Publishes a local track (from `mediaDevices.getUserMedia`) under `name`
   *  — the counterpart to a `sendonly` track the model declares. */
  async publishTrack(name: string, track: MediaStreamTrack): Promise<void> {
    this.assertNotDisposed();
    try {
      await this.queue.push(() =>
        this.getOrCreateClient().publishTrack(name, track as unknown as MediaStreamTrackLike),
      );
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  /** Never rejects — usually the last call in a `finally`. Failures go to the
   *  `error` event. */
  async unpublishTrack(name: string): Promise<void> {
    this.assertNotDisposed();
    try {
      await this.queue.push(() => this.getOrCreateClient().unpublishTrack(name));
    } catch (cause) {
      this.emitError(cause);
    }
  }

  async pauseTrack(name: string): Promise<void> {
    this.assertNotDisposed();
    try {
      await this.queue.push(() => this.getOrCreateClient().pauseTrack(name));
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  async resumeTrack(name: string): Promise<void> {
    this.assertNotDisposed();
    try {
      await this.queue.push(() => this.getOrCreateClient().resumeTrack(name));
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  /**
   * Bounds what one sender may spend, in bits per second. With nothing set,
   * libwebrtc caps a sender above 960x540 at 2.5 Mbps — this is how to lift
   * it. Needs a published track.
   */
  async setTrackBitrate(name: string, bounds: { minBps?: number; maxBps?: number } = {}): Promise<void> {
    this.assertNotDisposed();
    try {
      await this.queue.push(() => this.getOrCreateClient().setTrackBitrate(name, bounds.minBps, bounds.maxBps));
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  // ── Recording ───────────────────────────────────────────────────────────

  async requestClip(durationSeconds: number): Promise<Clip> {
    this.assertNotDisposed();
    try {
      return await this.withReaderAccess(async () =>
        toPublicClip(await this.getOrCreateClient().requestClip(durationSeconds)),
      );
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  async requestRecording(): Promise<Clip> {
    this.assertNotDisposed();
    try {
      return await this.withReaderAccess(async () =>
        toPublicClip(await this.getOrCreateClient().requestRecording()),
      );
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  /**
   * Downloads a clip to a local `.mp4` and resolves with its `file://` URI.
   * The React Native counterpart of the JS SDK's `downloadClipAsFile`, which
   * triggers a browser download instead. Needs `expo-file-system`.
   */
  async downloadClipAsFile(
    clip: Clip,
    filename: string | null = 'reactor-clip.mp4',
    options: DownloadClipOptions = {},
  ): Promise<string> {
    const jwt = options.jwt ?? (await this.resolveJwt());
    return downloadClip(clip, filename, jwt === undefined ? options : { ...options, jwt });
  }

  // ── Uploads ─────────────────────────────────────────────────────────────

  /**
   * Uploads a file to the session's object store and resolves with a
   * `FileRef` to pass in a `sendCommand()`'s `data`.
   *
   * React Native has no `File`: pass a `Blob`, bytes, or `{ uri }` — what
   * `expo-image-picker` and `expo-file-system` hand back.
   */
  async uploadFile(file: UploadInput, options?: { name?: string; mimeType?: string }): Promise<FileRef> {
    this.assertNotDisposed();
    try {
      const source = await readUpload(file, options);
      const wire = await this.queue.push(() => this.getOrCreateClient().uploadFile(source));
      return toPublicFileRef(wire);
    } catch (cause) {
      throw this.captureError(cause);
    }
  }

  tracks(): TrackCapability[] {
    return this.client?.tracks() ?? [];
  }

  trackMapping(): TrackMappingEntry[] {
    return this.client?.trackMapping() ?? [];
  }

  pausedTracks(): string[] {
    return this.client?.pausedTracks() ?? [];
  }

  // ── Escape hatches ──────────────────────────────────────────────────────

  getPeerConnection(): RTCPeerConnection | undefined {
    return this.client?.getPeerConnection() as RTCPeerConnection | undefined;
  }

  getTrackByMid(mid: string): MediaStreamTrack | undefined {
    return this.client?.getTrackByMid(mid) as MediaStreamTrack | undefined;
  }

  getStreamByMid(mid: string): MediaStream | undefined {
    return this.client?.getStreamByMid(mid) as MediaStream | undefined;
  }

  getTrackByName(name: string): MediaStreamTrack | undefined {
    return this.client?.getTrackByName(name) as MediaStreamTrack | undefined;
  }

  getStreamByName(name: string): MediaStream | undefined {
    return this.client?.getStreamByName(name) as MediaStream | undefined;
  }

  /**
   * Releases local resources and drops every handler for good; the instance
   * is unusable afterward. Also reachable as `[Symbol.dispose]` for `using`.
   * Does not end the session — call `disconnect()` first for that.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const client = this.client;
    this.client = undefined;
    this.schema = undefined;
    this.capabilities = undefined;
    this.resetConnectionState();
    this.emitter.clear();
    if (client) {
      void this.queue
        .push(() => this.withWriterAccess(() => Promise.resolve(client.free())))
        .catch(() => {});
    }
  }

  // ── Introspection ───────────────────────────────────────────────────────

  getStatus(): ReactorStatus {
    return this.client?.status() ?? 'disconnected';
  }

  getSessionId(): string | undefined {
    return this.client?.sessionId();
  }

  getJwtResolver(): JwtSource | undefined {
    return this.jwt ?? undefined;
  }

  getLastError(): ReactorError | undefined {
    return this._lastError;
  }

  getStats(): ConnectionStats | undefined {
    return this.stats;
  }

  getConnectionTimings(): ConnectionTimings | undefined {
    return this.connectionTimings;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  on<Name extends keyof ReactorEventMap>(event: Name, handler: ReactorEventMap[Name]): void {
    this.emitter.on(event, handler);
  }

  off<Name extends keyof ReactorEventMap>(event: Name, handler: ReactorEventMap[Name]): void {
    this.emitter.off(event, handler);
  }

  once<Name extends keyof ReactorEventMap>(event: Name, handler: ReactorEventMap[Name]): void {
    this.emitter.once(event, handler);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async resolveJwt(): Promise<string | undefined> {
    const source = this.jwt;
    if (source === null || source === undefined) return undefined;
    const token = typeof source === 'function' ? await source() : source;
    return token || undefined;
  }

  private getOrCreateClient(): ReactorClient {
    if (this.client) {
      return this.client;
    }
    if (this.disposed) {
      throw new Error('Reactor was disposed while connecting.');
    }
    const client = new ReactorClient(this.clientOptions, this.jwt, {
      webrtc: this.deps.webrtc ?? reactNativeWebRTC(),
      ...(this.deps.http ? { http: this.deps.http } : {}),
      ...(this.deps.wait ? { wait: this.deps.wait } : {}),
    });

    client.on('statusChanged', (status) => {
      this.emitter.emit('statusChanged', status);
      this.handleStatusChanged(client, status);
    });
    client.on('sessionIdChanged', (sessionId) => this.emitter.emit('sessionIdChanged', sessionId));
    client.on('error', (error) => this.emitError(error));
    client.on('message', (message) => this.emitter.emit('message', message));
    client.on('runtimeMessage', (message) => {
      // Clip events carry the wire clip; hand listeners the public shape.
      if (message.type === 'clipReady' && message.data && typeof message.data === 'object') {
        this.emitter.emit('runtimeMessage', { type: message.type, data: toPublicClip(message.data as WireClip) });
        return;
      }
      this.emitter.emit('runtimeMessage', message);
    });
    client.on('capabilitiesReceived', (capabilities) => {
      this.capabilities = toPublicCapabilities(capabilities);
      this.emitter.emit('capabilitiesReceived', this.capabilities);
    });
    client.on('trackReceived', (name, mid) => {
      const track = client.getTrackByName(name) as MediaStreamTrack | undefined;
      const stream = client.getStreamByName(name) as MediaStream | undefined;
      if (!track || !stream) {
        return;
      }
      this.emitter.emit('trackReceived', name, track, stream, mid);
    });
    this.client = client;
    return client;
  }

  private async refreshSchema(client: ReactorClient): Promise<void> {
    const refreshId = ++this.schemaRefreshId;
    try {
      const schema = this.normalizeSchema(await client.requestSchema());
      if (this.client !== client || refreshId !== this.schemaRefreshId || schema === undefined) {
        return;
      }
      this.schema = schema;
      this.emitter.emit('schemaReceived', schema);
      this.emitter.emit('runtimeMessage', { type: 'modelSchema', data: schema });
    } catch (cause) {
      if (this.client !== client || refreshId !== this.schemaRefreshId) {
        return;
      }
      this.emitError(cause);
    }
  }

  private normalizeSchema(schema: unknown): ModelSchema | undefined {
    return (schema ?? undefined) as ModelSchema | undefined;
  }

  private freeClient(): void {
    this.client?.free();
    this.client = undefined;
    this.schema = undefined;
    this.capabilities = undefined;
  }

  private handleStatusChanged(client: ReactorClient, status: ReactorStatus): void {
    switch (status) {
      case 'connecting':
        this.connectStartTime = now();
        this.waitingStartTime = undefined;
        break;
      case 'waiting':
        this.waitingStartTime = now();
        break;
      case 'ready': {
        const readyTime = now();
        if (this.connectStartTime != null) {
          const waitingStartTime = this.waitingStartTime ?? readyTime;
          this.connectionTimings = {
            sessionCreationMs: waitingStartTime - this.connectStartTime,
            transportConnectingMs: readyTime - waitingStartTime,
            totalMs: readyTime - this.connectStartTime,
          };
        }
        this.startStatsPolling(client);
        void this.refreshSchema(client);
        break;
      }
      default:
        this.stopStatsPolling();
    }
  }

  private startStatsPolling(client: ReactorClient): void {
    this.stopStatsPolling();
    const generation = ++this.statsPollGeneration;
    const extractStats = createRTCStatsExtractor();
    this.statsPollHandle = setInterval(() => {
      const peerConnection = client.getPeerConnection();
      if (!peerConnection) {
        return;
      }
      peerConnection
        .getStats()
        .then((report: unknown) => {
          if (generation !== this.statsPollGeneration) {
            return;
          }
          this.stats = { ...extractStats(report as RTCStatsReport), connectionTimings: this.connectionTimings };
          this.emitter.emit('statsUpdate', this.stats);
        })
        .catch(() => {
          // The connection may be closing.
        });
    }, STATS_INTERVAL_MS);
  }

  private stopStatsPolling(): void {
    this.statsPollGeneration += 1;
    if (this.statsPollHandle !== undefined) {
      clearInterval(this.statsPollHandle);
      this.statsPollHandle = undefined;
    }
    this.stats = undefined;
  }

  private resetConnectionState(): void {
    this.stopStatsPolling();
    this.connectionTimings = undefined;
    this.connectStartTime = undefined;
    this.waitingStartTime = undefined;
    this.capabilities = undefined;
  }

  private captureError(cause: unknown): ReactorError {
    const error = toReactorError(cause);
    this._lastError = error;
    return error;
  }

  private emitError(cause: unknown): void {
    this.emitter.emit('error', this.captureError(cause));
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("This Reactor was disposed and can't be used again — construct a new one.");
    }
  }
}

(Reactor.prototype as unknown as Record<symbol, () => void>)[disposeSymbol] = function (this: Reactor) {
  this.dispose();
};

/** Normalize everything `uploadFile()` accepts into what the core uploads. */
async function readUpload(
  file: UploadInput,
  options: { name?: string; mimeType?: string } = {},
): Promise<{ body: Blob | ArrayBuffer | Uint8Array; size: number; name: string; mimeType: string }> {
  const fallbackType = 'application/octet-stream';
  if (file instanceof Uint8Array || file instanceof ArrayBuffer) {
    return {
      body: file,
      size: file.byteLength,
      name: options.name ?? 'upload',
      mimeType: options.mimeType || fallbackType,
    };
  }
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    const named = file as Blob & { name?: string };
    return {
      body: file,
      size: file.size,
      name: options.name ?? named.name ?? 'upload',
      mimeType: options.mimeType || file.type || fallbackType,
    };
  }
  const { uri } = file as { uri: string; name?: string; type?: string; mimeType?: string };
  const reference = file as { name?: string; type?: string; mimeType?: string };
  // RN's fetch reads file:// and content:// URIs into a native-backed Blob,
  // which its fetch then sends as the PUT body without copying through JS.
  const blob = await (await fetch(uri)).blob();
  const name = options.name ?? reference.name ?? uri.split(/[\\/]/).pop()?.split('?')[0] ?? 'upload';
  return {
    body: blob,
    size: blob.size,
    name: name || 'upload',
    mimeType: options.mimeType || reference.mimeType || reference.type || blob.type || fallbackType,
  };
}

export { FileRef };
