/**
 * The JSON shapes of the coordinator API and the HTTP signaling protocol —
 * `crates/reactor-protocol/src/{session,webrtc,upload}.rs`, with the same
 * snake_case wire names.
 */

export const REACTOR_API_VERSION = '1';
export const REACTOR_WEBRTC_VERSION = '1.0';
export const API_VERSION_HEADER = 'Reactor-API-Version';
export const API_ACCEPT_VERSION_HEADER = 'Reactor-API-Accept-Version';
export const WEBRTC_VERSION_HEADER = 'Reactor-WebRTC-Version';

/** Negotiated SCTP limit when the engine does not report one. */
export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;

export type ReactorStatus = 'disconnected' | 'connecting' | 'waiting' | 'ready';
export type TrackKind = 'audio' | 'video';
export type TrackDirection = 'recvonly' | 'sendonly';

export type SessionState =
  | 'CREATED'
  | 'PENDING'
  | 'SUSPENDED'
  | 'WAITING'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'CLOSED'
  | (string & {});

export const isTerminalSessionState = (state: SessionState) => state === 'INACTIVE' || state === 'CLOSED';

export interface ClientInfo {
  sdk_version: string;
  sdk_type: string;
}

export interface TrackCapability {
  name: string;
  kind: TrackKind;
  direction: TrackDirection;
}

export interface TrackMappingEntry extends TrackCapability {
  mid: string;
}

export interface CommandCapability {
  name: string;
  description?: string;
  schema?: unknown;
}

export interface WireCapabilities {
  protocol_version: string;
  tracks: TrackCapability[];
  commands?: CommandCapability[];
  emission_fps?: number;
}

export interface SessionResponse {
  session_id: string;
  state: SessionState;
  model?: { name: string; version?: string };
  cluster?: string;
  server_info?: { server_version: string };
  selected_transport?: { protocol: string; version: string };
  capabilities?: WireCapabilities;
  [key: string]: unknown;
}

/** Connectable once the runtime accepted it: a transport was selected and
 *  capabilities are published. */
export const isSessionReady = (session: SessionResponse) =>
  session.capabilities !== undefined && session.capabilities !== null && session.selected_transport != null;

export interface IceServer {
  uris: string[];
  credentials?: { username: string; password: string };
}

export interface IceCandidate {
  candidate: string;
  sdp_mid?: string;
  sdp_mline_index?: number;
}

export interface SdpAnswerResponse {
  sdp_answer: string;
  connection_id?: number;
}

export interface CreateUploadResponse {
  presigned_id: string;
  presigned_url: string;
  path: string;
}

export interface WireFileRef {
  upload_id: string;
  name: string;
  mime_type: string;
  size: number;
}

export interface WireClip {
  session_id: string;
  kind: string;
  start_marker: number;
  end_marker: number;
  now_marker: number;
  predicted_ready_at_ms: number;
  playlist_url: string;
}

// ── Polling ─────────────────────────────────────────────────────────────────

export interface PollConfig {
  initialMs: number;
  maxMs: number;
  multiplier: number;
  maxAttempts: number;
}

/** `GET /sessions/{id}` readiness polling: 200ms → 10s, 20 attempts. */
export const SESSION_POLL: PollConfig = { initialMs: 200, maxMs: 10_000, multiplier: 2, maxAttempts: 20 };
/** SDP-answer polling: 200ms → 15s, 6 attempts. */
export const SDP_POLL: PollConfig = { initialMs: 200, maxMs: 15_000, multiplier: 2, maxAttempts: 6 };

export function backoff(config: PollConfig): () => number {
  let next = config.initialMs;
  return () => {
    const current = next;
    next = Math.min(current * config.multiplier, config.maxMs);
    return current;
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
