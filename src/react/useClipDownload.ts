import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { RecordingError, downloadClip, isAbortError } from '../recording';
import { ReactorContext } from './ReactorProvider';
import type { Clip } from '../types';

export type ClipDownloadState =
  | { kind: 'idle' }
  | { kind: 'downloading'; fetched: number; total: number }
  | { kind: 'error'; message: string };

export interface UseClipDownloadOptions {
  /** File name in the cache directory. Default `"reactor-clip.mp4"`;
   *  `null` names it after the clip. */
  filename?: string | null;
  /** Coordinator JWT for the manifest. Inherits the provider's when omitted. */
  getJwt?: () => string | Promise<string>;
}

export interface UseClipDownloadResult {
  state: ClipDownloadState;
  /** Resolves with the saved file's `file://` URI (a `Blob` in the browser
   *  SDK), or `undefined` if the download failed or was superseded. */
  download: () => Promise<string | undefined>;
  reset: () => void;
}

/**
 * Downloads a clip to the app's cache directory, with progress. Share or save
 * the resulting URI with `expo-sharing` / `expo-media-library`.
 */
export function useClipDownload(clip: Clip, options: UseClipDownloadOptions = {}): UseClipDownloadResult {
  const [state, setState] = useState<ClipDownloadState>({ kind: 'idle' });
  const store = useContext(ReactorContext);
  const clipRef = useRef(clip);
  const filenameRef = useRef<string | null>(options.filename === undefined ? 'reactor-clip.mp4' : options.filename);
  const getJwtRef = useRef(options.getJwt);
  const storeRef = useRef(store);
  clipRef.current = clip;
  filenameRef.current = options.filename === undefined ? 'reactor-clip.mp4' : options.filename;
  getJwtRef.current = options.getJwt;
  storeRef.current = store;

  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const download = useCallback(async (): Promise<string | undefined> => {
    if (inFlightRef.current) {
      return undefined;
    }
    inFlightRef.current = true;
    const abort = new AbortController();
    abortRef.current = abort;
    setState({ kind: 'downloading', fetched: 0, total: 0 });
    try {
      const jwt = await resolveJwt(getJwtRef.current, storeRef.current?.getState().internal.reactor.getJwtResolver());
      const uri = await downloadClip(clipRef.current, filenameRef.current, {
        signal: abort.signal,
        onProgress: ({ fetched, total }) => setState({ kind: 'downloading', fetched, total }),
        ...(jwt !== undefined ? { jwt } : {}),
      });
      setState({ kind: 'idle' });
      return uri;
    } catch (err) {
      if (isAbortError(err)) {
        return undefined;
      }
      const message =
        err instanceof RecordingError ? `${err.code}: ${err.reason}` : err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message });
      return undefined;
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const reset = useCallback(() => setState({ kind: 'idle' }), []);
  return { state, download, reset };
}

export async function resolveJwt(
  explicit: (() => string | Promise<string>) | undefined,
  fallback: string | (() => string | Promise<string>) | undefined,
): Promise<string | undefined> {
  if (explicit) {
    return (await explicit()) || undefined;
  }
  if (fallback === undefined) {
    return undefined;
  }
  return (typeof fallback === 'function' ? await fallback() : fallback) || undefined;
}
