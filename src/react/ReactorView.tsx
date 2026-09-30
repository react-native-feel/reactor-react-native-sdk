import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { useReactor } from './hooks';
import type { MediaStream, MediaStreamTrack } from '../types';

export interface ReactorViewProps {
  /** Name of the recvonly video track to render. Defaults to `"main_video"`. */
  track?: string;
  /** Name of a recvonly audio track this view controls — see `muted`. */
  audioTrack?: string;
  width?: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
  /** `RTCView` supports these two; `"fill"`/`"none"`/`"scale-down"` from the
   *  browser's `object-fit` map to the nearest of them. */
  videoObjectFit?: 'contain' | 'cover' | 'fill' | 'none' | 'scale-down';
  /**
   * Whether `audioTrack` is silenced. Defaults to `true` when no `audioTrack`
   * is set, `false` otherwise — the browser SDK's defaults.
   *
   * One platform difference: a browser only plays audio an element was given,
   * while on a phone every received audio track plays through the device on
   * its own. So `muted` works by disabling `audioTrack` itself, and an audio
   * track no view names keeps playing — `pauseTrack()` it to stop it at the
   * source.
   */
  muted?: boolean;
  /** React Native only: mirror the picture horizontally. */
  mirror?: boolean;
  /** React Native only: `RTCView`'s z-order, for stacking one video over
   *  another (Android renders each on its own surface). */
  zOrder?: number;
  /** React Native only: shown until the track arrives. Default: nothing, on
   *  the black background. */
  placeholder?: ReactNode;
}

/** The current track and stream for `name`, kept live across
 *  `trackReceived` events — and read straight off the Reactor on mount, so a
 *  view that mounts after the track arrived still shows it. */
function useReceivedTrack(name: string | undefined): { track?: MediaStreamTrack; stream?: MediaStream } {
  const reactor = useReactor((state) => state.internal.reactor);
  const status = useReactor((state) => state.status);
  const read = () =>
    name ? { track: reactor.getTrackByName(name), stream: reactor.getStreamByName(name) } : {};
  const [received, setReceived] = useState<{ track?: MediaStreamTrack; stream?: MediaStream }>(read);

  useEffect(() => {
    setReceived(read());
    if (!name) {
      return;
    }
    const listener = (receivedName: string, track: MediaStreamTrack, stream: MediaStream) => {
      if (receivedName === name) {
        setReceived({ track, stream });
      }
    };
    reactor.on('trackReceived', listener);
    return () => reactor.off('trackReceived', listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reactor, name]);

  // A disconnect invalidates what arrived under the previous connection.
  useEffect(() => {
    if (status === 'disconnected') {
      setReceived({});
    }
  }, [status]);

  return received;
}

export function ReactorView({
  track = 'main_video',
  audioTrack,
  width,
  height,
  style,
  videoObjectFit = 'contain',
  muted = audioTrack === undefined,
  mirror = false,
  zOrder,
  placeholder,
}: ReactorViewProps) {
  const video = useReceivedTrack(track);
  const audio = useReceivedTrack(audioTrack);
  // Bumped on `unmute` to remount the RTCView. A recvonly track negotiated
  // while the runtime has it paused arrives muted; when frames start, some
  // renderers keep showing black on the surface they already bound — the
  // browser SDK re-attaches `srcObject` for the same reason.
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const target = video.track as unknown as {
      addEventListener?: (type: string, fn: () => void) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
    };
    if (!target?.addEventListener) {
      return;
    }
    const onUnmute = () => setEpoch((n) => n + 1);
    target.addEventListener('unmute', onUnmute);
    return () => target.removeEventListener?.('unmute', onUnmute);
  }, [video.track]);

  useEffect(() => {
    if (audio.track) {
      audio.track.enabled = !muted;
    }
  }, [audio.track, muted]);

  const streamURL = useMemo(() => {
    const stream = video.stream as unknown as { toURL?: () => string } | undefined;
    return typeof stream?.toURL === 'function' ? stream.toURL() : undefined;
  }, [video.stream]);

  const objectFit = videoObjectFit === 'cover' || videoObjectFit === 'fill' ? 'cover' : 'contain';

  return (
    <View
      style={[
        styles.container,
        width !== undefined && { width },
        height !== undefined && { height },
        style,
      ]}
    >
      {streamURL && video.track ? (
        <RTCView
          key={`${streamURL}:${epoch}`}
          streamURL={streamURL}
          style={StyleSheet.absoluteFill}
          objectFit={objectFit}
          mirror={mirror}
          {...(zOrder !== undefined ? { zOrder } : {})}
        />
      ) : (
        placeholder ?? null
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    backgroundColor: '#000',
    overflow: 'hidden',
  },
});
