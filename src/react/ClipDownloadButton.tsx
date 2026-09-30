import { useEffect, useRef, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { useClipDownload, type ClipDownloadState, type UseClipDownloadOptions } from './useClipDownload';
import type { Clip } from '../types';

export interface ClipDownloadButtonProps {
  clip: Clip;
  /** Optional inside a `ReactorProvider`, which lends its own resolver. */
  getJwt?: () => string | Promise<string>;
  /** File name in the cache directory. Default `"reactor-clip.mp4"`. */
  filename?: string;
  /** A static label, or a function of the download state. Default: a label
   *  that follows the state (`Download` / `Downloading 3/8…`). */
  children?: ReactNode | ((state: ClipDownloadState) => ReactNode);
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  /** Fires with the saved file's `file://` URI (a `Blob` in the browser SDK)
   *  — hand it to `expo-sharing` or `expo-media-library`. */
  onSuccess?: (uri: string) => void;
  onError?: (error: Error) => void;
}

/** One-tap download of a clip to the device, reflecting its progress. */
export function ClipDownloadButton({
  clip,
  getJwt,
  filename = 'reactor-clip.mp4',
  children,
  style,
  disabled,
  onSuccess,
  onError,
}: ClipDownloadButtonProps) {
  const options: UseClipDownloadOptions = { filename };
  if (getJwt !== undefined) options.getJwt = getJwt;
  const { state, download } = useClipDownload(clip, options);
  const isDisabled = state.kind === 'downloading' || !!disabled;

  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  onSuccessRef.current = onSuccess;
  onErrorRef.current = onError;

  useEffect(() => {
    if (state.kind === 'error') {
      onErrorRef.current?.(new Error(state.message));
    }
  }, [state]);

  const content = typeof children === 'function' ? children(state) : (children ?? defaultLabel(state));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: state.kind === 'downloading' }}
      accessibilityHint={state.kind === 'error' ? state.message : undefined}
      disabled={isDisabled}
      onPress={() => {
        void download().then((uri) => {
          if (uri) onSuccessRef.current?.(uri);
        });
      }}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {typeof content === 'string' ? <Text style={styles.label}>{content}</Text> : content}
    </Pressable>
  );
}

function defaultLabel(state: ClipDownloadState): string {
  if (state.kind === 'downloading') {
    return state.total > 0 ? `Downloading ${state.fetched}/${state.total}…` : 'Downloading…';
  }
  return 'Download';
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.25)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
  },
  pressed: { backgroundColor: 'rgba(255,255,255,0.16)' },
  disabled: { opacity: 0.6 },
  label: {
    color: '#fff',
    fontSize: 13,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
});
