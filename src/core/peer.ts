/**
 * The WebRTC engine seam — `reactor-core`'s `PeerTransport` trait, and its
 * implementation over a W3C-shaped WebRTC API.
 *
 * In the browser that API is the browser's, reached from Rust through
 * `web-sys` (`crates/reactor-wasm/src/peer.rs`). Here it is
 * `react-native-webrtc`, which implements the same surface over libwebrtc —
 * the approach story-smash's Director stream already runs in production. The
 * engine is injected (see `WebRTCImplementation`) rather than imported, so
 * this file has no native dependency and the test suite drives it with a fake.
 *
 * Every engine callback becomes a `PeerEvent` handed to the orchestrator.
 * Nothing here awaits inside a callback, so no callback can re-enter the
 * orchestrator mid-operation.
 */
import { ReactorError } from '../errors';
import { invalidState, peerError } from './errors';
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  type IceCandidate,
  type IceServer,
  type TrackCapability,
  type TrackMappingEntry,
} from './protocol';

// ── The subset of the W3C WebRTC API this transport uses ────────────────────
//
// Structural, so react-native-webrtc's classes, a browser's, and the test
// fakes all satisfy it without this package depending on DOM typings.

type Listener = (event: any) => void;

export interface MediaStreamTrackLike {
  readonly id: string;
  readonly kind: string;
  enabled: boolean;
  addEventListener?(type: string, listener: Listener): void;
  removeEventListener?(type: string, listener: Listener): void;
  stop?(): void;
}

export interface MediaStreamLike {
  readonly id: string;
  getTracks(): MediaStreamTrackLike[];
  getVideoTracks(): MediaStreamTrackLike[];
  getAudioTracks(): MediaStreamTrackLike[];
  /** react-native-webrtc only: what `RTCView`'s `streamURL` takes. */
  toURL?(): string;
}

export interface EncodingLike {
  maxBitrate?: number | null | undefined;
  minBitrate?: number | null | undefined;
}

export interface RtpSenderLike {
  readonly track: MediaStreamTrackLike | null;
  replaceTrack(track: MediaStreamTrackLike | null): Promise<void>;
  getParameters(): { encodings: EncodingLike[] };
  setParameters(parameters: any): Promise<void>;
}

export interface RtpTransceiverLike {
  readonly mid: string | null;
  direction: string;
  readonly sender: RtpSenderLike;
}

export interface DataChannelLike {
  readonly readyState: string;
  binaryType: string;
  addEventListener(type: string, listener: Listener): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
}

export interface PeerConnectionLike {
  readonly connectionState: string;
  createDataChannel(label: string, init?: Record<string, unknown>): DataChannelLike;
  addTransceiver(kind: 'audio' | 'video', init: { direction: string }): RtpTransceiverLike;
  addEventListener(type: string, listener: Listener): void;
  createOffer(options?: Record<string, unknown>): Promise<{ sdp?: string | undefined; type?: string }>;
  setLocalDescription(description: { type: string; sdp: string }): Promise<void>;
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  getStats(): Promise<any>;
  close(): void;
}

export interface WebRTCImplementation {
  RTCPeerConnection: new (configuration: {
    iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
  }) => PeerConnectionLike;
  MediaStream: new (tracks: MediaStreamTrackLike[]) => MediaStreamLike;
}

// ── Events and the transport contract ───────────────────────────────────────

export type PeerConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export type PeerEvent =
  | { type: 'connectionState'; state: PeerConnectionState }
  | { type: 'dataChannelOpen' }
  | { type: 'controlChannelOpen' }
  | { type: 'dataMessage'; bytes: Uint8Array }
  | { type: 'controlMessage'; bytes: Uint8Array }
  | { type: 'trackReceived'; mid: string | undefined }
  | { type: 'iceCandidate'; candidate: IceCandidate }
  | { type: 'iceGatheringComplete' };

export interface PreparedOffer {
  sdpOffer: string;
  trackMapping: TrackMappingEntry[];
}

export interface ReceivedTrack {
  track: MediaStreamTrackLike;
  stream: MediaStreamLike;
}

interface SenderBitrate {
  minBps: number | undefined;
  maxBps: number | undefined;
}

interface PeerState {
  pc: PeerConnectionLike;
  dataChannel: DataChannelLike;
  controlChannel: DataChannelLike;
  transceivers: Map<string, RtpTransceiverLike>;
  directions: Map<string, string>;
}

async function applySenderBitrate(
  transceiver: RtpTransceiverLike,
  minBps: number | undefined,
  maxBps: number | undefined,
): Promise<void> {
  const sender = transceiver.sender;
  // getParameters() must be the immediate source of what goes back into
  // setParameters(): engines stamp it with a transaction id.
  const params = sender.getParameters();
  const first = params.encodings?.[0];
  if (!first) {
    throw peerError('sender has no encodings');
  }
  // `null` clears a bound back to the engine default — react-native-webrtc's
  // encoding setters treat it that way, and a browser drops a null key.
  first.maxBitrate = maxBps ?? null;
  first.minBitrate = minBps ?? null;
  try {
    await sender.setParameters(params);
  } catch (cause) {
    throw peerError(`setParameters rejected the bitrate bounds: ${describe(cause)}`);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') {
    // A text frame: the orchestrator decides what it is, as the core does.
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff;
    return out;
  }
  return undefined;
}

export class WebRTCPeerTransport {
  private state: PeerState | undefined;
  /** Kept outside `state`: every `prepare()` builds fresh senders on engine
   *  defaults, and a reconnect must keep what the caller asked for. */
  private readonly trackBitrates = new Map<string, SenderBitrate>();
  private readonly received = new Map<string, ReceivedTrack>();
  /** Bumped by every `close()`, so callbacks from a torn-down connection are
   *  dropped instead of reaching the orchestrator as the new one's. */
  private generation = 0;

  constructor(
    private readonly webrtc: WebRTCImplementation,
    private readonly emit: (event: PeerEvent) => void,
  ) {}

  get peerConnection(): PeerConnectionLike | undefined {
    return this.state?.pc;
  }

  receivedTrack(mid: string): ReceivedTrack | undefined {
    return this.received.get(mid);
  }

  maxMessageBytes(): number {
    return DEFAULT_MAX_MESSAGE_BYTES;
  }

  async prepare(iceServers: IceServer[], tracks: TrackCapability[]): Promise<PreparedOffer> {
    // A stale connection would keep its callbacks wired; reconnect() calls
    // prepare() again, so close first.
    await this.close();
    const generation = this.generation;
    const live = (fn: (event: any) => void) => (event: any) => {
      if (generation === this.generation) fn(event);
    };

    const pc = new this.webrtc.RTCPeerConnection({
      iceServers: iceServers.map((server) => ({
        urls: server.uris,
        ...(server.credentials
          ? { username: server.credentials.username, credential: server.credentials.password }
          : {}),
      })),
    });

    // Control first, then data. A runtime that predates per-label routing
    // collapses every inbound channel onto the last one opened, and this
    // order makes that the data channel, where the model's traffic rides.
    const controlChannel = pc.createDataChannel('control');
    const dataChannel = pc.createDataChannel('data');
    controlChannel.binaryType = 'arraybuffer';
    dataChannel.binaryType = 'arraybuffer';

    // One transceiver per declared track, in declaration order.
    const transceivers = new Map<string, RtpTransceiverLike>();
    const directions = new Map<string, string>();
    for (const track of tracks) {
      const transceiver = pc.addTransceiver(track.kind, { direction: track.direction });
      transceivers.set(track.name, transceiver);
      directions.set(track.name, track.direction);
    }

    pc.addEventListener(
      'icecandidate',
      live((event) => {
        const candidate = event?.candidate;
        if (!candidate || !candidate.candidate) {
          // A null candidate is the end-of-gathering signal.
          this.emit({ type: 'iceGatheringComplete' });
          return;
        }
        const entry: IceCandidate = { candidate: candidate.candidate };
        if (candidate.sdpMid != null) entry.sdp_mid = candidate.sdpMid;
        if (candidate.sdpMLineIndex != null) entry.sdp_mline_index = candidate.sdpMLineIndex;
        this.emit({ type: 'iceCandidate', candidate: entry });
      }),
    );

    pc.addEventListener(
      'connectionstatechange',
      live(() => {
        const state = pc.connectionState as PeerConnectionState;
        // A state this engine names but the core does not know is not a
        // reason to report a connection that is not there.
        const known: PeerConnectionState[] = ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'];
        this.emit({ type: 'connectionState', state: known.includes(state) ? state : 'new' });
      }),
    );

    pc.addEventListener(
      'track',
      live((event) => {
        const track: MediaStreamTrackLike = event.track;
        const mid: string | undefined = event.transceiver?.mid ?? undefined;
        // The spec allows an empty `streams`; wrap the track so a consumer
        // always has a stream to render (and, on RN, a `toURL()`).
        const stream: MediaStreamLike = event.streams?.[0] ?? new this.webrtc.MediaStream([track]);
        if (mid !== undefined) {
          this.received.set(mid, { track, stream });
        }
        this.emit({ type: 'trackReceived', mid });
      }),
    );

    const wire = (channel: DataChannelLike, open: PeerEvent, message: 'dataMessage' | 'controlMessage') => {
      channel.addEventListener(
        'open',
        live(() => this.emit(open)),
      );
      channel.addEventListener(
        'message',
        live((event) => {
          const bytes = toBytes(event?.data);
          if (bytes) {
            this.emit({ type: message, bytes });
          }
        }),
      );
    };
    wire(dataChannel, { type: 'dataChannelOpen' }, 'dataMessage');
    wire(controlChannel, { type: 'controlChannelOpen' }, 'controlMessage');

    // The engine's offer is sent as written — the wasm transport stopped
    // munging SDP, and so does this one.
    let sdpOffer: string;
    try {
      const offer = await pc.createOffer();
      if (!offer.sdp) {
        throw peerError('createOffer returned no sdp');
      }
      sdpOffer = offer.sdp;
      // Starts ICE gathering — the candidate listener is already wired.
      await pc.setLocalDescription({ type: 'offer', sdp: sdpOffer });
    } catch (cause) {
      pc.close();
      throw cause instanceof ReactorError ? cause : peerError(describe(cause));
    }

    // mids exist only after setLocalDescription.
    const trackMapping: TrackMappingEntry[] = tracks.flatMap((track) => {
      const transceiver = transceivers.get(track.name);
      return transceiver ? [{ ...track, mid: transceiver.mid ?? '' }] : [];
    });

    // Reapply remembered bounds to the fresh senders. Best-effort: a rejected
    // ceiling is a quality problem, not a reason to fail a connect.
    for (const [name, bounds] of this.trackBitrates) {
      const transceiver = transceivers.get(name);
      if (!transceiver) continue;
      try {
        await applySenderBitrate(transceiver, bounds.minBps, bounds.maxBps);
      } catch (error) {
        console.warn(`[reactor] bitrate bounds for track '${name}' rejected: ${describe(error)}`);
      }
    }

    this.state = { pc, dataChannel, controlChannel, transceivers, directions };
    return { sdpOffer, trackMapping };
  }

  async setRemoteDescription(sdpAnswer: string): Promise<void> {
    const state = this.requireState();
    try {
      await state.pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });
    } catch (cause) {
      throw peerError(describe(cause));
    }
  }

  sendData(payload: Uint8Array): void {
    send(this.requireState().dataChannel, payload);
  }

  sendControl(payload: Uint8Array): void {
    send(this.requireState().controlChannel, payload);
  }

  /** Pause/resume, local half: an inactive receiver stops decoding. The
   *  runtime is told separately, on the control channel. */
  async setTrackDirection(trackName: string, active: boolean): Promise<void> {
    const state = this.requireState();
    const transceiver = state.transceivers.get(trackName);
    if (!transceiver) {
      throw invalidState(`no transceiver for track '${trackName}'`);
    }
    transceiver.direction = active ? (state.directions.get(trackName) ?? 'recvonly') : 'inactive';
  }

  async setTrackBitrate(trackName: string, minBps: number | undefined, maxBps: number | undefined): Promise<void> {
    const transceiver = this.requireState().transceivers.get(trackName);
    if (!transceiver) {
      throw invalidState(`no transceiver for track '${trackName}'`);
    }
    // Applied before it is remembered, so a rejected pair is never replayed.
    await applySenderBitrate(transceiver, minBps, maxBps);
    this.trackBitrates.set(trackName, { minBps, maxBps });
  }

  /** Attach (or detach, with `null`) local media on a sendonly track. */
  async replaceSenderTrack(trackName: string, track: MediaStreamTrackLike | null): Promise<void> {
    const transceiver = this.requireState().transceivers.get(trackName);
    if (!transceiver) {
      throw invalidState(`no transceiver for track '${trackName}'`);
    }
    try {
      await transceiver.sender.replaceTrack(track);
    } catch (cause) {
      throw invalidState(`replaceTrack on '${trackName}' failed: ${describe(cause)}`);
    }
  }

  async close(): Promise<void> {
    this.generation++;
    const state = this.state;
    this.state = undefined;
    if (state) {
      for (const close of [() => state.dataChannel.close(), () => state.controlChannel.close(), () => state.pc.close()]) {
        try {
          close();
        } catch {
          // Already closed; nothing left to release.
        }
      }
    }
    this.received.clear();
  }

  private requireState(): PeerState {
    if (!this.state) {
      throw invalidState('peer transport not prepared');
    }
    return this.state;
  }
}

/** Checks `readyState` first rather than letting the engine throw: the
 *  heartbeat racing a teardown hits this constantly, and on a single-threaded
 *  JS loop nothing can change the state between the check and the send. */
function send(channel: DataChannelLike, payload: Uint8Array): void {
  if (channel.readyState !== 'open') {
    throw invalidState(`data channel not open (state: ${channel.readyState})`);
  }
  try {
    channel.send(payload);
  } catch (cause) {
    throw peerError(describe(cause));
  }
}
