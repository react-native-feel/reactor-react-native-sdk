import { useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { RecordingError, assembleClipBytes, fetchPlaylist, isAbortError, writeCacheFile } from '../recording';
import { ReactorContext } from './ReactorProvider';
import { resolveJwt } from './useClipDownload';
import type { Clip } from '../types';

declare const require: (id: string) => any;

// Optional peer dependency. Metro treats a require inside try/catch as
// optional, so an app without expo-video still bundles — ClipPlayer then
// renders an error saying what to install instead of breaking the build.
let ExpoVideo: { useVideoPlayer: any; VideoView: any } | undefined;
try {
  ExpoVideo = require('expo-video');
} catch {
  ExpoVideo = undefined;
}

export interface ClipPlayerProps {
  clip: Clip;
  /** Coordinator JWT for the manifest. Inherits the provider's when omitted;
   *  omit in local development. */
  getJwt?: () => string | Promise<string>;
  /** Opt-in bound on the wait for the clip to become ready. */
  slackMs?: number;
  autoPlay?: boolean;
  muted?: boolean;
  /**
   * React Native only. How the clip reaches the player:
   *
   * - `"download"` fetches the segments into one MP4 in the cache directory
   *   and plays that. Works with any auth, because the player never sees a
   *   credential.
   * - `"stream"` hands the playlist URL straight to the player. Only for
   *   unauthenticated runtimes: the player would send the coordinator's
   *   `Authorization` header to the presigned segment URLs as well, which
   *   object storage rejects.
   *
   * Default: `"download"` when there is a JWT, `"stream"` when there is not.
   */
  strategy?: 'download' | 'stream';
  contentFit?: 'contain' | 'cover' | 'fill';
  nativeControls?: boolean;
  style?: StyleProp<ViewStyle>;
  onError?: (error: Error) => void;
}

type Phase =
  | { kind: 'waiting' }
  | { kind: 'loading'; fetched: number; total: number }
  | { kind: 'ready'; uri: string }
  | { kind: 'error'; message: string; error: Error };

/**
 * Plays a captured clip with `expo-video`. Like the browser `ClipPlayer`, it
 * needs no `ReactorProvider` — it works from the `Clip` alone, after a
 * disconnect too.
 */
export function ClipPlayer(props: ClipPlayerProps) {
  if (!ExpoVideo) {
    return (
      <View style={[styles.container, props.style]}>
        <Text style={styles.message}>ClipPlayer needs expo-video: npx expo install expo-video</Text>
      </View>
    );
  }
  return <ClipPlayerWithVideo {...props} video={ExpoVideo} />;
}

function ClipPlayerWithVideo({
  clip,
  getJwt,
  slackMs,
  autoPlay = true,
  muted = true,
  strategy,
  contentFit = 'contain',
  nativeControls = true,
  style,
  onError,
  video,
}: ClipPlayerProps & { video: { useVideoPlayer: any; VideoView: any } }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' });
  const store = useContext(ReactorContext);
  const getJwtRef = useRef(getJwt);
  const storeRef = useRef(store);
  const slackMsRef = useRef(slackMs);
  const strategyRef = useRef(strategy);
  const onErrorRef = useRef(onError);
  getJwtRef.current = getJwt;
  storeRef.current = store;
  slackMsRef.current = slackMs;
  strategyRef.current = strategy;
  onErrorRef.current = onError;

  const player = video.useVideoPlayer(null, (p: { muted: boolean; loop: boolean }) => {
    p.muted = muted;
    p.loop = false;
  });

  useEffect(() => {
    player.muted = muted;
  }, [player, muted]);

  useEffect(() => {
    if (phase.kind === 'error') onErrorRef.current?.(phase.error);
  }, [phase]);

  // Depends on the clip only: an inline `getJwt` must not refetch on every
  // render. Everything else is read through refs at request time.
  useEffect(() => {
    const abort = new AbortController();
    setPhase({ kind: 'waiting' });

    (async () => {
      const jwt = await resolveJwt(getJwtRef.current, storeRef.current?.getState().internal.reactor.getJwtResolver());
      const mode = strategyRef.current ?? (jwt ? 'download' : 'stream');
      const manifest = await fetchPlaylist(clip.playlistUrl, {
        predictedReadyAtMs: clip.predictedReadyAtMs,
        signal: abort.signal,
        ...(jwt ? { jwt } : {}),
        ...(slackMsRef.current !== undefined ? { slackMs: slackMsRef.current } : {}),
      });
      if (mode === 'stream') {
        return clip.playlistUrl;
      }
      setPhase({ kind: 'loading', fetched: 0, total: 0 });
      const bytes = await assembleClipBytes(manifest, clip.playlistUrl, {
        signal: abort.signal,
        onProgress: ({ fetched, total }) => setPhase({ kind: 'loading', fetched, total }),
      });
      const name = `reactor-clip-${clip.sessionId}-${Math.round(clip.startMarker * 1000)}-${Math.round(
        clip.endMarker * 1000,
      )}.mp4`;
      return writeCacheFile(name.replace(/[^\w.-]/g, '_'), bytes);
    })()
      .then((uri) => {
        if (abort.signal.aborted) return;
        player.replace(uri.endsWith('.m3u8') ? { uri, contentType: 'hls' } : { uri });
        if (autoPlay) player.play();
        setPhase({ kind: 'ready', uri });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted || isAbortError(error)) return;
        const err = error instanceof Error ? error : new Error(String(error));
        const message = err instanceof RecordingError ? `${err.code}: ${err.reason}` : err.message;
        setPhase({ kind: 'error', message, error: err });
      });

    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, player]);

  const VideoView = video.VideoView;
  return (
    <View style={[styles.container, style]}>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit={contentFit} nativeControls={nativeControls} />
      {phase.kind !== 'ready' && (
        <View style={styles.overlay} pointerEvents="none">
          {phase.kind === 'error' ? (
            <Text style={styles.message}>{phase.message}</Text>
          ) : (
            <>
              <ActivityIndicator color="#fff" />
              <Text style={styles.message}>
                {phase.kind === 'loading' && phase.total > 0
                  ? `Loading ${phase.fetched}/${phase.total}…`
                  : 'Waiting for the clip…'}
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#000', overflow: 'hidden', aspectRatio: 16 / 9 },
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 },
  message: {
    color: '#fff',
    fontSize: 12,
    textAlign: 'center',
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
});
