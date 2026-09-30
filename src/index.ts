/**
 * react-native-reactor — the Reactor React SDK's API on React Native.
 *
 * Exports the same names as `@reactor-team/js-sdk`, so a component written
 * against `<ReactorProvider>`/`<ReactorView>`/`useReactor` moves across with
 * its imports changed and little else. Platform differences are documented
 * on the members they affect and collected in the README.
 */
export { Reactor, SDK_VERSION } from './reactor';
export {
  ReactorError,
  NetworkError,
  UnauthorizedError,
  NotFoundError,
  ConflictError,
  RateLimitedError,
  BadRequestError,
  ServerError,
  VersionMismatchError,
  DecodeError,
  InvalidStateError,
  SessionTerminalError,
  MessageTooLargeError,
  TransportError,
  DisconnectedError,
  RequestTimeoutError,
  AbortedError,
  RecorderDisabledError,
} from './errors';
export {
  DEFAULT_PLAYLIST_POLL_SLACK_MS,
  RecordingError,
  absolutizeManifest,
  assembleClipBytes,
  downloadClip,
  downloadClipAsFile,
  fetchPlaylist,
  parsePlaylist,
} from './recording';
export type { DownloadClipOptions, FetchPlaylistOptions, ParsedPlaylist } from './recording';
export { FileRef, isFileRef } from './file-ref';
export { normalizeJwtSource } from './jwt';
export type { JwtResolver } from './jwt';
export type {
  Capabilities,
  Clip,
  ClipKind,
  CommandCapability,
  ConnectionStats,
  ConnectionTimings,
  ConnectOptions,
  JwtSource,
  MediaStream,
  MediaStreamTrack,
  MessageScope,
  ModelSchema,
  ModelSchemaOperation,
  ModelSchemaPathItem,
  ModerationAction,
  ModerationEvent,
  ReactorEventMap,
  ReactorEventName,
  ReactorMessage,
  ReactorOptions,
  ReactorStatus,
  SessionResponse,
  TrackCapability,
  TrackDirection,
  TrackKind,
  TrackMappingEntry,
  UploadInput,
} from './types';
export { ReactorProvider, ReactorContext, useReactorStore } from './react/ReactorProvider';
export type { ReactorConnectOptions, ReactorProviderProps } from './react/ReactorProvider';
export { useReactor, useReactorMessage, useReactorInternalMessage, useStats } from './react/hooks';
export type { ReactorActions, ReactorState, ReactorStore } from './react/store';
export { ReactorView } from './react/ReactorView';
export type { ReactorViewProps } from './react/ReactorView';
export { WebcamStream } from './react/WebcamStream';
export type { CameraConstraints, WebcamStreamProps } from './react/WebcamStream';
export { ClipPlayer } from './react/ClipPlayer';
export type { ClipPlayerProps } from './react/ClipPlayer';
export { ClipDownloadButton } from './react/ClipDownloadButton';
export type { ClipDownloadButtonProps } from './react/ClipDownloadButton';
export { useClipDownload } from './react/useClipDownload';
export type { ClipDownloadState, UseClipDownloadOptions, UseClipDownloadResult } from './react/useClipDownload';
export { ReactorAudio } from './audio';
export type { ReactorAudioMode } from './audio';

// Advanced: the protocol core, for a custom media engine or a headless client.
export { ReactorClient } from './core/client';
export type { ClientDeps, ClientOptions } from './core/client';
export type { WebRTCImplementation } from './core/peer';
export type { HttpClient } from './core/http';
