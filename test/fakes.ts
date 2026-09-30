/**
 * A fake Reactor platform: a coordinator answering HTTP, and a WebRTC engine
 * whose far end is a fake runtime speaking real `reactor_wire.v1` bytes.
 *
 * Deliberately behaves like the real thing in the ways the orchestrator
 * depends on: mids are assigned only at setLocalDescription, the SDP answer
 * is 202 until it is ready, channels open and tracks arrive only after the
 * remote description is applied.
 */
import type { HttpClient, HttpRequest, HttpResponse } from '../src/core/http';
import type {
  DataChannelLike,
  MediaStreamLike,
  MediaStreamTrackLike,
  PeerConnectionLike,
  RtpTransceiverLike,
  WebRTCImplementation,
} from '../src/core/peer';
import type { TrackCapability } from '../src/core/protocol';
import {
  MessageKind,
  decodeControlClientMessage,
  decodeDataClientMessage,
  encodeControlServerMessage,
  encodeDataServerMessage,
  type ControlClientMessage,
  type ControlServerPayload,
  type DataClientMessage,
  type DataServerPayload,
} from '../src/core/wire';

type Listener = (event: any) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }
  fire(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

let trackCounter = 0;

export class FakeTrack extends FakeEventTarget implements MediaStreamTrackLike {
  readonly id = `track-${++trackCounter}`;
  enabled = true;
  stopped = false;
  constructor(readonly kind: string) {
    super();
  }
  stop(): void {
    this.stopped = true;
  }
}

export class FakeStream implements MediaStreamLike {
  readonly id = `stream-${++trackCounter}`;
  constructor(private readonly tracks: MediaStreamTrackLike[]) {}
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  toURL() {
    return `stream://${this.id}`;
  }
}

export class FakeChannel extends FakeEventTarget implements DataChannelLike {
  readyState = 'connecting';
  binaryType = 'blob';
  readonly sent: Uint8Array[] = [];
  onSend: ((bytes: Uint8Array) => void) | undefined;
  constructor(readonly label: string) {
    super();
  }
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError');
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
          : new TextEncoder().encode(data);
    this.sent.push(bytes);
    this.onSend?.(bytes);
  }
  open(): void {
    this.readyState = 'open';
    this.fire('open');
  }
  receive(bytes: Uint8Array): void {
    // react-native-webrtc delivers binary frames as ArrayBuffers.
    this.fire('message', { data: bytes.slice().buffer });
  }
  close(): void {
    this.readyState = 'closed';
  }
}

export class FakeSender {
  track: MediaStreamTrackLike | null = null;
  params = { encodings: [{ maxBitrate: null as number | null, minBitrate: null as number | null }] };
  readonly applied: Array<{ maxBitrate: number | null | undefined; minBitrate: number | null | undefined }> = [];
  async replaceTrack(track: MediaStreamTrackLike | null) {
    this.track = track;
  }
  getParameters() {
    return this.params;
  }
  async setParameters(params: any) {
    const first = params.encodings[0];
    this.applied.push({ maxBitrate: first.maxBitrate, minBitrate: first.minBitrate });
  }
}

export class FakeTransceiver implements RtpTransceiverLike {
  mid: string | null = null;
  readonly sender = new FakeSender();
  readonly directionHistory: string[] = [];
  private _direction: string;
  constructor(
    readonly kind: 'audio' | 'video',
    direction: string,
  ) {
    this._direction = direction;
  }
  get direction() {
    return this._direction;
  }
  set direction(value: string) {
    this._direction = value;
    this.directionHistory.push(value);
  }
}

export class FakePeerConnection extends FakeEventTarget implements PeerConnectionLike {
  connectionState = 'new';
  readonly channels: FakeChannel[] = [];
  readonly transceivers: FakeTransceiver[] = [];
  closed = false;
  localSdp: string | undefined;
  remoteSdp: string | undefined;

  constructor(
    readonly configuration: { iceServers: Array<{ urls: string[]; username?: string; credential?: string }> },
    private readonly platform: FakePlatform,
  ) {
    super();
    platform.connections.push(this);
  }

  createDataChannel(label: string): FakeChannel {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }

  channel(label: string): FakeChannel {
    return this.channels.find((c) => c.label === label)!;
  }

  addTransceiver(kind: 'audio' | 'video', init: { direction: string }): FakeTransceiver {
    const transceiver = new FakeTransceiver(kind, init.direction);
    this.transceivers.push(transceiver);
    return transceiver;
  }

  async createOffer() {
    return { type: 'offer', sdp: `v=0 fake offer with ${this.transceivers.length} m-lines` };
  }

  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localSdp = description.sdp;
    this.transceivers.forEach((t, i) => (t.mid = String(i)));
    // Gathering starts here; candidates trickle asynchronously.
    queueMicrotask(() => {
      if (this.closed) return;
      this.fire('icecandidate', {
        candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
      });
      this.fire('icecandidate', { candidate: null });
    });
  }

  async setRemoteDescription(description: { type: string; sdp: string }) {
    this.remoteSdp = description.sdp;
    if (this.platform.failOnRemoteDescription) {
      throw new Error('remote description rejected');
    }
    queueMicrotask(() => {
      if (this.closed || this.platform.stallTransport) return;
      this.transceivers.forEach((t) => {
        if (t.direction === 'recvonly') {
          const track = new FakeTrack(t.kind);
          this.fire('track', { track, streams: [new FakeStream([track])], transceiver: t });
        }
      });
      this.setState('connected');
      this.channels.forEach((c) => c.open());
    });
  }

  setState(state: string): void {
    this.connectionState = state;
    this.fire('connectionstatechange');
  }

  async getStats() {
    return new Map([
      [
        'pair',
        {
          id: 'pair',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: 0.05,
          localCandidateId: 'local',
          bytesReceived: 1000,
          timestamp: Date.now(),
        },
      ],
      ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay', timestamp: Date.now() }],
    ]);
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

// ── The platform ────────────────────────────────────────────────────────────

export interface FakePlatformOptions {
  tracks?: TrackCapability[];
  /** How many GET /sessions/{id} polls return PENDING before ACTIVE. */
  pendingPolls?: number;
  /** How many SDP polls return 202 before the answer. */
  sdpPending?: number;
}

export class FakePlatform {
  readonly requests: HttpRequest[] = [];
  readonly connections: FakePeerConnection[] = [];
  readonly controlReceived: ControlClientMessage[] = [];
  readonly dataReceived: DataClientMessage[] = [];
  readonly uploaded: Array<{ url: string; body: unknown }> = [];
  failOnRemoteDescription = false;
  stallTransport = false;
  sessionDeleted = false;
  tracks: TrackCapability[];
  private polls = 0;
  private sdpPolls = 0;

  /** How the fake runtime answers a command. Default: echo it back. */
  onCommand: (message: DataClientMessage) => DataServerPayload | undefined | 'silent' = (message) =>
    message.payload?.case === 'command'
      ? { case: 'message', value: { type: 'echo', data: message.payload.value.data } }
      : undefined;

  /** How the fake runtime answers a control request. */
  onControl: (message: ControlClientMessage) => ControlServerPayload | undefined = (message) => {
    const p = message.payload;
    if (p?.case === 'publish_track') return { case: 'publish_track', value: { name: p.value.name } };
    if (p?.case === 'request_schema') {
      return {
        case: 'model_schema',
        value: { openapi: { openapi: '3.1.0', info: { title: 'fake', version: '1' } } },
      };
    }
    if (p?.case === 'request_clip') {
      return {
        case: 'clip_ready',
        value: {
          session_id: 'sess_1',
          kind: 'snap',
          start_marker: 0,
          end_marker: p.value.duration_seconds,
          now_marker: p.value.duration_seconds,
          predicted_ready_at_ms: 1_800_000_000_000,
          playlist_url: '/sessions/sess_1/clips/c1.m3u8',
        },
      };
    }
    return undefined;
  };

  constructor(private readonly options: FakePlatformOptions = {}) {
    this.tracks = options.tracks ?? [
      { name: 'main_video', kind: 'video', direction: 'recvonly' },
      { name: 'main_audio', kind: 'audio', direction: 'recvonly' },
      { name: 'webcam', kind: 'video', direction: 'sendonly' },
    ];
  }

  get pc(): FakePeerConnection {
    return this.connections[this.connections.length - 1]!;
  }

  readonly webrtc: WebRTCImplementation = {
    RTCPeerConnection: ((platform: FakePlatform) =>
      class extends FakePeerConnection {
        constructor(configuration: any) {
          super(configuration, platform);
          // Wire the fake runtime to answer what the client sends.
          queueMicrotask(() => {
            this.channel('control').onSend = (bytes) => platform.handleControl(this, bytes);
            this.channel('data').onSend = (bytes) => platform.handleData(this, bytes);
          });
        }
      })(this) as any,
    MediaStream: FakeStream as any,
  };

  handleControl(pc: FakePeerConnection, bytes: Uint8Array): void {
    const message = decodeControlClientMessage(bytes);
    this.controlReceived.push(message);
    if (message.kind !== MessageKind.Request) return;
    const payload = this.onControl(message);
    if (payload) {
      queueMicrotask(() =>
        pc
          .channel('control')
          .receive(encodeControlServerMessage({ request_id: message.request_id, kind: MessageKind.Response, payload })),
      );
    }
  }

  handleData(pc: FakePeerConnection, bytes: Uint8Array): void {
    const message = decodeDataClientMessage(bytes);
    this.dataReceived.push(message);
    const payload = this.onCommand(message);
    if (payload === 'silent') return;
    queueMicrotask(() =>
      pc.channel('data').receive(
        encodeDataServerMessage({
          request_id: message.request_id,
          kind: MessageKind.Response,
          ...(payload ? { payload } : {}),
        }),
      ),
    );
  }

  /** The runtime pushing something unprompted. */
  pushControl(payload: ControlServerPayload): void {
    this.pc
      .channel('control')
      .receive(encodeControlServerMessage({ request_id: '', kind: MessageKind.Notification, payload }));
  }

  pushData(payload: DataServerPayload): void {
    this.pc.channel('data').receive(encodeDataServerMessage({ request_id: '', kind: MessageKind.Notification, payload }));
  }

  readonly http: HttpClient = async (request) => {
    this.requests.push(request);
    const url = new URL(request.url);
    const path = url.pathname;
    const json = (status: number, body?: unknown, headers: Record<string, string> = {}): HttpResponse => ({
      status,
      header: (name) => headers[name.toLowerCase()],
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    });

    if (url.host === 'uploads.example.com') {
      this.uploaded.push({ url: request.url, body: request.body });
      return json(200);
    }
    if (request.method === 'POST' && path === '/sessions') {
      return json(200, { session_id: 'sess_1', state: 'CREATED' });
    }
    if (request.method === 'GET' && path === '/sessions/sess_1') {
      if (this.polls++ < (this.options.pendingPolls ?? 1)) {
        return json(200, { session_id: 'sess_1', state: 'PENDING' });
      }
      return json(200, {
        session_id: 'sess_1',
        state: 'ACTIVE',
        cluster: 'test',
        selected_transport: { protocol: 'webrtc', version: '1.0' },
        capabilities: { protocol_version: '1.0', tracks: this.tracks, emission_fps: 24 },
      });
    }
    if (request.method === 'DELETE' && path === '/sessions/sess_1') {
      this.sessionDeleted = true;
      return json(200);
    }
    if (request.method === 'POST' && path === '/sessions/sess_1/uploads') {
      return json(200, {
        presigned_id: 'up_1',
        presigned_url: 'https://uploads.example.com/put?sig=1',
        path: 'uploads/up_1',
      });
    }
    const base = '/sessions/sess_1/transport/webrtc';
    if (path === `${base}/ice_servers`) {
      return json(200, {
        ice_servers: [
          { uris: ['stun:stun.example.com:3478'] },
          { uris: ['turn:turn.example.com:3478'], credentials: { username: 'u', password: 'p' } },
        ],
      });
    }
    if (path === `${base}/connections`) {
      return json(200, { connection_id: 4242 });
    }
    if (path === `${base}/connections/4242/sdp_params`) {
      if (request.method === 'GET') {
        if (this.sdpPolls++ < (this.options.sdpPending ?? 1)) return json(202);
        return json(200, { sdp_answer: 'v=0 fake answer' });
      }
      return json(200);
    }
    if (path === `${base}/connections/4242/ice_candidates`) {
      return json(200);
    }
    return json(404, { error: `no route for ${request.method} ${path}` });
  };
}

/** Let every queued microtask and resolved promise settle. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
