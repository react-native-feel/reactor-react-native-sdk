/**
 * Public types — the same names and shapes as `@reactor-team/js-sdk`'s
 * `types.ts`, so code written against the React SDK type-checks here.
 *
 * The one deliberate difference: media objects are `react-native-webrtc`'s
 * `MediaStream`/`MediaStreamTrack`, not the DOM's. They implement the same
 * interface, plus `stream.toURL()`, which is what `RTCView` renders.
 */
import type { MediaStream, MediaStreamTrack, RTCPeerConnection } from 'react-native-webrtc';
import type { ReactorError } from './errors';
import type { ClientOptions, ConnectOptions } from './core/client';
import type { JwtSource } from './core/http';
import type {
  ReactorStatus,
  SessionResponse,
  TrackCapability,
  TrackDirection,
  TrackKind,
  TrackMappingEntry,
} from './core/protocol';

export type {
  ConnectOptions,
  JwtSource,
  ReactorStatus,
  SessionResponse,
  TrackCapability,
  TrackDirection,
  TrackKind,
  TrackMappingEntry,
};
export type { MediaStream, MediaStreamTrack, RTCPeerConnection };

export interface ReactorMessage {
  type: string;
  data: unknown;
}

export type MessageScope = 'application' | 'runtime';

/** Anything but a function — what `sendCommand`'s `data` accepts. */
export type NotFunction<T> = T extends (...args: never[]) => unknown ? never : T;

export interface CommandCapability {
  name: string;
  description?: string;
  schema?: unknown;
}

export interface Capabilities {
  protocolVersion: string;
  tracks: TrackCapability[];
  commands?: CommandCapability[];
  emissionFps?: number;
}

export interface ModelSchemaOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  responses?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelSchemaPathItem {
  post?: ModelSchemaOperation;
  [key: string]: unknown;
}

export interface ModelSchema {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths?: Record<string, ModelSchemaPathItem>;
  webhooks?: Record<string, ModelSchemaPathItem>;
  'x-reactor'?: {
    tracks?: Array<{ name: string; kind: string; direction: string }>;
  };
  components?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ModerationAction = 'warn' | 'terminate';

export interface ModerationEvent {
  action: ModerationAction;
  input_kind: 'text' | 'image';
  command: string;
  categories: string[];
  message: string;
}

export interface ReactorOptions extends Omit<ClientOptions, 'sdkType'> {
  jwt?: JwtSource;
  /** Reported to the coordinator as `client_info.sdk_type`. */
  sdkType?: string;
}

export interface ConnectionTimings {
  sessionCreationMs: number;
  transportConnectingMs: number;
  totalMs: number;
}

export interface ConnectionStats {
  /** Round-trip time in milliseconds. */
  rtt?: number | undefined;
  /** `host` | `srflx` | `prflx` | `relay` — `relay` means TURN. */
  candidateType?: string | undefined;
  availableIncomingBitrate?: number | undefined;
  availableOutgoingBitrate?: number | undefined;
  incomingBitrate?: number | undefined;
  outgoingBitrate?: number | undefined;
  framesPerSecond?: number | undefined;
  packetLossRatio?: number | undefined;
  jitter?: number | undefined;
  connectionTimings?: ConnectionTimings | undefined;
  timestamp: number;
}

export type ClipKind = 'snap' | 'recording';

export interface Clip {
  sessionId: string;
  kind: ClipKind;
  startMarker: number;
  endMarker: number;
  nowMarker: number;
  predictedReadyAtMs: number;
  playlistUrl: string;
}

export interface ReactorEventMap {
  statusChanged: (status: ReactorStatus) => void;
  sessionIdChanged: (sessionId: string | undefined) => void;
  error: (error: ReactorError) => void;
  message: (message: ReactorMessage) => void;
  runtimeMessage: (message: ReactorMessage) => void;
  schemaReceived: (schema: ModelSchema) => void;
  capabilitiesReceived: (capabilities: Capabilities) => void;
  trackReceived: (name: string, track: MediaStreamTrack, stream: MediaStream, mid: string | undefined) => void;
  statsUpdate: (stats: ConnectionStats) => void;
}

export type ReactorEventName = keyof ReactorEventMap;

/**
 * What `uploadFile()` accepts on React Native, where there is no `File`:
 *
 * - a `Blob` (e.g. from `fetch(uri).then(r => r.blob())`),
 * - raw bytes (`ArrayBuffer` / `Uint8Array`),
 * - or a local file reference — `{ uri }`, the shape image pickers and
 *   `expo-file-system` hand back — read through `fetch(uri)`.
 */
export type UploadInput =
  | Blob
  | ArrayBuffer
  | Uint8Array
  | { uri: string; name?: string | undefined; type?: string | undefined; mimeType?: string | undefined };
