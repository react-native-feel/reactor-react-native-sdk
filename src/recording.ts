/**
 * Clip playlists and downloads — the JS SDK's `recording.ts`, for React Native.
 *
 * `fetchPlaylist` and `parsePlaylist` are the browser SDK's own, with the DOM
 * taken out of them (no `DOMException`, no `new URL(relative, base)`, which
 * React Native's URL polyfill does not implement). What differs is the end of
 * the pipeline: a browser gets a `<a download>`; a phone gets a file in the
 * app's cache directory, via `expo-file-system`, whose `file://` URI can go
 * to `expo-sharing`, `expo-media-library` or `expo-video`.
 *
 * The runtime's clip is fragmented MP4 (an init segment plus media segments);
 * concatenated, it is a valid MP4 that AVPlayer and ExoPlayer both play. The
 * browser SDK additionally remuxes it to a flat MP4 with `mp4box`, which is
 * not carried over — it holds the whole file in JS memory twice, which a
 * phone can afford less than a desktop tab.
 */
import type { Clip } from './types';

declare const require: (id: string) => any;

export class RecordingError extends Error {
  constructor(
    public readonly code:
      | 'CLIP_GONE'
      | 'CLIP_NOT_READY'
      | 'PLAYLIST_FETCH_FAILED'
      | 'CHUNK_FETCH_FAILED'
      | 'INVALID_PLAYLIST'
      | 'DOWNLOAD_UNSUPPORTED',
    public readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = 'RecordingError';
  }
}

export const DEFAULT_PLAYLIST_POLL_SLACK_MS = 15_000;

export interface FetchPlaylistOptions {
  /** Pass `clip.predictedReadyAtMs`; anchors the optional `slackMs` deadline. */
  predictedReadyAtMs?: number;
  /** Opt-in grace period after which a stuck `202` becomes `CLIP_NOT_READY`.
   *  Omit to poll until ready or aborted. */
  slackMs?: number;
  maxRetryDelayMs?: number;
  minRetryDelayMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  /** Coordinator JWT for the manifest GET. The segments it lists are
   *  presigned URLs, fetched without it. */
  jwt?: string;
}

export interface ParsedPlaylist {
  initUrl: string;
  segmentUrls: string[];
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** RFC 3986 reference resolution, for the cases a playlist actually uses:
 *  absolute URLs, root-relative paths and path-relative segment names. */
export function resolveAgainst(target: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return target;
  }
  const match = base.match(/^([a-z][a-z0-9+.-]*:)?(\/\/[^/?#]*)?([^?#]*)/i);
  if (!match) {
    return target;
  }
  const scheme = match[1] ?? '';
  const authority = match[2] ?? '';
  const basePath = match[3] ?? '';
  if (target.startsWith('//')) {
    return `${scheme}${target}`;
  }
  let path: string;
  let rest = '';
  const split = target.search(/[?#]/);
  const targetPath = split === -1 ? target : target.slice(0, split);
  if (split !== -1) rest = target.slice(split);
  if (targetPath === '') {
    path = basePath;
  } else if (targetPath.startsWith('/')) {
    path = targetPath;
  } else {
    path = `${basePath.slice(0, basePath.lastIndexOf('/') + 1)}${targetPath}`;
  }
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '..') {
      if (out.length > 1) out.pop();
    } else if (segment !== '.') {
      out.push(segment);
    }
  }
  let normalized = out.join('/');
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  return `${scheme}${authority}${normalized}${rest}`;
}

function parseRetryAfter(header: string | null, fallbackMs: number): number {
  if (!header) {
    return fallbackMs;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? fallbackMs : Math.max(0, dateMs - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Fetch `playlistUrl`, polling while the runtime answers `202 Accepted` (the
 * boundary chunk is still uploading).
 *
 * `200` → the manifest · `404`/`410` → `CLIP_GONE` · other → `PLAYLIST_FETCH_FAILED`.
 */
export async function fetchPlaylist(playlistUrl: string, options: FetchPlaylistOptions = {}): Promise<string> {
  const minDelay = Math.max(0, options.minRetryDelayMs ?? 200);
  const maxDelay = Math.max(minDelay, options.maxRetryDelayMs ?? 2_000);
  const startedPollingAt = Date.now();
  const deadlineMs =
    typeof options.slackMs === 'number' && Number.isFinite(options.slackMs)
      ? Math.max(options.predictedReadyAtMs ?? startedPollingAt, startedPollingAt) + options.slackMs
      : undefined;
  const init: RequestInit = {};
  if (options.signal) init.signal = options.signal;
  if (options.jwt) init.headers = { Authorization: `Bearer ${options.jwt}` };

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(playlistUrl, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new RecordingError('PLAYLIST_FETCH_FAILED', `Network error fetching playlist: ${(error as Error).message}`);
    }
    if (response.status === 202) {
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        throw new RecordingError(
          'CLIP_NOT_READY',
          `Boundary chunk still pending after ${options.slackMs}ms grace. Runtime may have crashed mid-clip.`,
        );
      }
      if (options.maxRetries !== undefined && attempt >= options.maxRetries) {
        throw new RecordingError('CLIP_NOT_READY', `Manifest still pending after ${attempt + 1} attempts (last status 202)`);
      }
      const delay = Math.min(maxDelay, Math.max(minDelay, parseRetryAfter(response.headers.get('Retry-After'), minDelay)));
      await sleep(deadlineMs !== undefined ? Math.min(delay, Math.max(0, deadlineMs - Date.now())) : delay, options.signal);
      continue;
    }
    if (response.status === 200) {
      return response.text();
    }
    if (response.status === 404 || response.status === 410) {
      throw new RecordingError('CLIP_GONE', 'Clip is no longer available or session unknown');
    }
    throw new RecordingError('PLAYLIST_FETCH_FAILED', `Manifest endpoint returned HTTP ${response.status}`);
  }
}

/** The init segment and the ordered media segments of an HLS manifest,
 *  resolved against the playlist's own URL. */
export function parsePlaylist(manifestBody: string, playlistUrl: string): ParsedPlaylist {
  let initUrl: string | undefined;
  const segmentUrls: string[] = [];
  for (const rawLine of manifestBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP')) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (uri) initUrl = resolveAgainst(uri, playlistUrl);
      continue;
    }
    if (line.startsWith('#')) continue;
    segmentUrls.push(resolveAgainst(line, playlistUrl));
  }
  if (!initUrl) {
    throw new RecordingError('INVALID_PLAYLIST', 'Playlist is missing an #EXT-X-MAP init segment URI');
  }
  if (segmentUrls.length === 0) {
    throw new RecordingError('INVALID_PLAYLIST', 'Playlist contains no media segments');
  }
  return { initUrl, segmentUrls };
}

/** The manifest with every segment URI made absolute — what a player needs
 *  when the manifest is served from somewhere other than where it came from
 *  (a local file). */
export function absolutizeManifest(manifestBody: string, playlistUrl: string): string {
  const eol = manifestBody.includes('\r\n') ? '\r\n' : '\n';
  return manifestBody
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('#EXT-X-MAP')) {
        return line.replace(/URI="([^"]+)"/, (_, uri: string) => `URI="${resolveAgainst(uri, playlistUrl)}"`);
      }
      const trimmed = line.trim();
      return !trimmed || trimmed.startsWith('#') ? line : resolveAgainst(trimmed, playlistUrl);
    })
    .join(eol);
}

export interface DownloadClipOptions {
  jwt?: string;
  signal?: AbortSignal;
  onProgress?: (info: { fetched: number; total: number; bytes: number }) => void;
}

/** Fetch every segment a manifest lists, in order, into one MP4's bytes. */
export async function assembleClipBytes(
  manifestBody: string,
  playlistUrl: string,
  options: Omit<DownloadClipOptions, 'jwt'> = {},
): Promise<Uint8Array> {
  const { initUrl, segmentUrls } = parsePlaylist(manifestBody, playlistUrl);
  const urls = [initUrl, ...segmentUrls];
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for (const [i, url] of urls.entries()) {
    let response: Response;
    try {
      response = await fetch(url, options.signal ? { signal: options.signal } : {});
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new RecordingError('CHUNK_FETCH_FAILED', `Network error fetching chunk ${i}: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new RecordingError('CHUNK_FETCH_FAILED', `Chunk ${i} returned HTTP ${response.status}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    parts.push(data);
    bytes += data.byteLength;
    options.onProgress?.({ fetched: i + 1, total: urls.length, bytes });
  }
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function fileSystem(): { File: any; Paths: any } {
  try {
    return require('expo-file-system');
  } catch (cause) {
    throw new RecordingError(
      'DOWNLOAD_UNSUPPORTED',
      `saving a clip needs expo-file-system (npx expo install expo-file-system): ${String(cause)}`,
    );
  }
}

/** Write bytes to `<cache>/<filename>` and return its `file://` URI. */
export function writeCacheFile(filename: string, bytes: Uint8Array | string): string {
  const { File, Paths } = fileSystem();
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri as string;
}

/**
 * Download `clip` to the app's cache directory and resolve with the file's
 * `file://` URI. `filename: null` names the file after the clip itself. For
 * the bytes without a file, use {@link fetchPlaylist} + {@link assembleClipBytes}.
 */
export async function downloadClip(
  clip: Clip,
  filename: string | null = 'reactor-clip.mp4',
  options: DownloadClipOptions = {},
): Promise<string> {
  const playlistOptions: FetchPlaylistOptions = { predictedReadyAtMs: clip.predictedReadyAtMs };
  if (options.signal) playlistOptions.signal = options.signal;
  if (options.jwt) playlistOptions.jwt = options.jwt;
  const manifest = await fetchPlaylist(clip.playlistUrl, playlistOptions);
  const bytes = await assembleClipBytes(manifest, clip.playlistUrl, options);
  return writeCacheFile(filename ?? `reactor-clip-${clip.sessionId}-${Math.round(clip.endMarker)}.mp4`, bytes);
}

/** The JS SDK's name for it. On React Native it resolves with a `file://`
 *  URI rather than a `Blob`. */
export const downloadClipAsFile = downloadClip;
