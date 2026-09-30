import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { mediaDevices, RTCView } from 'react-native-webrtc';
import { useReactor } from './hooks';
import type { ReactorError } from '../errors';
import type { MediaStream } from '../types';

/** Camera constraints as `react-native-webrtc` understands them. */
export interface CameraConstraints {
  width?: number | { ideal?: number; min?: number; max?: number };
  height?: number | { ideal?: number; min?: number; max?: number };
  frameRate?: number | { ideal?: number; min?: number; max?: number };
  facingMode?: 'user' | 'environment';
  deviceId?: string;
}

export interface WebcamStreamProps {
  /** Name of the sendonly video track to publish the camera to. */
  track: string;
  /** Capture and publish the microphone too. Requires `audioTrack`. */
  audio?: boolean | Record<string, unknown>;
  /** Name of the sendonly audio track for the microphone. */
  audioTrack?: string;
  style?: StyleProp<ViewStyle>;
  /** Read once, at mount. Default 1280x720, front camera. */
  videoConstraints?: CameraConstraints;
  showWebcam?: boolean;
  videoObjectFit?: 'contain' | 'cover';
  /** React Native only: mirror the preview. Defaults to `true` for the front
   *  camera — what people expect of a selfie view. Only the preview is
   *  mirrored; the model receives the camera's own orientation. */
  mirror?: boolean;
  /** Fires when camera (or microphone) permission is refused. */
  onPermissionDenied?: () => void;
  /** Fires after the local media is published. Re-fires after a reconnect. */
  onPublished?: () => void;
  /** Non-permission capture failures, and publish/unpublish rejections. */
  onError?: (error: Error) => void;
}

const DEFAULT_VIDEO_CONSTRAINTS: CameraConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  facingMode: 'user',
};

/** `react-native-webrtc` reports a refused permission as `SecurityError`
 *  (its own permission check) or `NotAllowedError` (the OS). */
function isPermissionDenied(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
}

const asError = (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason)));

export function WebcamStream({
  track,
  audio = false,
  audioTrack,
  style,
  videoConstraints = DEFAULT_VIDEO_CONSTRAINTS,
  showWebcam = true,
  videoObjectFit = 'contain',
  mirror,
  onPermissionDenied,
  onPublished,
  onError,
}: WebcamStreamProps) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [published, setPublished] = useState<{ video: string; audio?: string } | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const { status, publish, unpublish, reactor } = useReactor((state) => ({
    status: state.status,
    publish: state.publish,
    unpublish: state.unpublish,
    reactor: state.internal.reactor,
  }));

  const onPermissionDeniedRef = useRef(onPermissionDenied);
  const onPublishedRef = useRef(onPublished);
  const onErrorRef = useRef(onError);
  onPermissionDeniedRef.current = onPermissionDenied;
  onPublishedRef.current = onPublished;
  onErrorRef.current = onError;

  const audioEnabled = audio !== false && audioTrack !== undefined;

  // The mount effect below runs once; its cleanup reads the latest values
  // from here so teardown unpublishes what is actually published.
  const latestRef = useRef({ published, unpublish, stream });
  latestRef.current = { published, unpublish, stream };

  useEffect(() => {
    let cancelled = false;

    mediaDevices
      .getUserMedia({
        video: videoConstraints as never,
        audio: (audioEnabled ? audio : false) as never,
      })
      .then((mediaStream) => {
        if (cancelled) {
          mediaStream.getTracks().forEach((t) => t.stop());
          return;
        }
        setStream(mediaStream as unknown as MediaStream);
        setPermissionDenied(false);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        if (isPermissionDenied(err)) {
          setPermissionDenied(true);
          onPermissionDeniedRef.current?.();
        } else {
          onErrorRef.current?.(asError(err));
        }
      });

    return () => {
      cancelled = true;
      const current = latestRef.current;
      const tasks: Array<Promise<void>> = [];
      if (current.published) {
        tasks.push(current.unpublish(current.published.video));
        if (current.published.audio) {
          tasks.push(current.unpublish(current.published.audio));
        }
      }
      if (tasks.length > 0) {
        void Promise.allSettled(tasks).then((results) => {
          for (const r of results) {
            if (r.status === 'rejected') onErrorRef.current?.(asError(r.reason));
          }
        });
      }
      // Stop capture even if unpublishing failed: a camera left running keeps
      // the green indicator on after the screen is gone.
      current.stream?.getTracks().forEach((t) => t.stop());
      (current.stream as unknown as { release?: (releaseTracks?: boolean) => void } | null)?.release?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!stream) {
      return;
    }
    let cancelled = false;
    const desiredAudio = audioEnabled ? audioTrack : undefined;
    const activeStream = stream;

    async function sync() {
      if (status === 'ready') {
        if (published && published.video === track && published.audio === desiredAudio) {
          return;
        }
        if (published) {
          const rollback: Array<Promise<void>> = [unpublish(published.video)];
          if (published.audio) rollback.push(unpublish(published.audio));
          await Promise.allSettled(rollback);
          if (cancelled) return;
          setPublished(null);
        }

        const videoMediaTrack = activeStream.getVideoTracks()[0];
        const audioMediaTrack = desiredAudio ? activeStream.getAudioTracks()[0] : undefined;
        const attempts: Array<{ name: string; task: Promise<void> }> = [];
        if (videoMediaTrack) {
          attempts.push({ name: track, task: publish(track, videoMediaTrack) });
        }
        if (audioMediaTrack && desiredAudio) {
          attempts.push({ name: desiredAudio, task: publish(desiredAudio, audioMediaTrack) });
        }
        if (attempts.length === 0) return;

        const results = await Promise.allSettled(attempts.map((a) => a.task));
        if (cancelled) return;

        const failureIndex = results.findIndex((r) => r.status === 'rejected');
        if (failureIndex !== -1) {
          // Never report an error while leaving some names published.
          const succeeded = attempts.filter((_, i) => results[i]?.status === 'fulfilled');
          await Promise.allSettled(succeeded.map((a) => unpublish(a.name)));
          if (cancelled) return;
          onErrorRef.current?.(asError((results[failureIndex] as PromiseRejectedResult).reason));
          return;
        }

        const next: { video: string; audio?: string } = { video: track };
        if (audioMediaTrack && desiredAudio) next.audio = desiredAudio;
        setPublished(next);
        onPublishedRef.current?.();
      } else if (published) {
        const tasks: Array<Promise<void>> = [unpublish(published.video)];
        if (published.audio) tasks.push(unpublish(published.audio));
        const results = await Promise.allSettled(tasks);
        if (cancelled) return;
        for (const r of results) {
          if (r.status === 'rejected') onErrorRef.current?.(asError(r.reason));
        }
        setPublished(null);
      }
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, [status, stream, published, publish, unpublish, track, audioEnabled, audioTrack]);

  // A publish the runtime later reports as failed: forget it, so the sync
  // effect publishes again.
  useEffect(() => {
    const handleError = (error: ReactorError) => {
      if (error.code === 'TRACK_PUBLISH_FAILED') setPublished(null);
    };
    reactor.on('error', handleError);
    return () => reactor.off('error', handleError);
  }, [reactor]);

  const streamURL = (stream as unknown as { toURL?: () => string } | null)?.toURL?.();
  const mirrored = mirror ?? (videoConstraints.facingMode ?? 'user') === 'user';

  return (
    <View style={[styles.container, !showWebcam && styles.hidden, style]}>
      {streamURL ? (
        <RTCView streamURL={streamURL} style={StyleSheet.absoluteFill} objectFit={videoObjectFit} mirror={mirrored} />
      ) : (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>
            {permissionDenied
              ? 'Camera access denied.\nAllow it in Settings to stream your camera.'
              : 'Starting camera...'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative', backgroundColor: '#000', overflow: 'hidden' },
  hidden: { display: 'none' },
  placeholder: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', padding: 20 },
  placeholderText: { color: '#fff', fontSize: 12, fontFamily: Platform.select({ ios: 'Courier', default: 'monospace' }), textAlign: 'center' },
});
