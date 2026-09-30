/**
 * Where a Reactor stream's audio comes out of the phone.
 *
 * Received audio plays through libwebrtc as call audio, which both iOS and
 * Android route to the **earpiece** by default. `ReactorAudio.setMode()`
 * applies the audio-session policy of the Reactor Swift SDK's `ReactorMedia`
 * instead — see `ios/ReactorAudioModule.swift` for the reasoning.
 *
 * - `"media"` — watching a model: loudspeaker unless headphones are in.
 * - `"voiceChat"` — publishing a microphone as well: voice processing on,
 *   still defaulting to the loudspeaker (the Swift SDK's `Microphone`).
 * - `"default"` — hand the session back to libwebrtc's own defaults.
 *
 * The native half ships with this package as an Expo module. Without a
 * development build that includes it (Expo Go, a bare app without
 * expo-modules), every call resolves as a no-op and `isAvailable` is false.
 */
declare const require: (id: string) => any;

export type ReactorAudioMode = 'media' | 'voiceChat' | 'default';

interface NativeReactorAudio {
  setMode(mode: ReactorAudioMode): Promise<void>;
  getRoute(): string[];
}

function loadNative(): NativeReactorAudio | null {
  try {
    const core = require('expo-modules-core');
    return (core.requireOptionalNativeModule?.('ReactorAudio') as NativeReactorAudio | null) ?? null;
  } catch {
    return null;
  }
}

let native: NativeReactorAudio | null | undefined;
const getNative = () => (native === undefined ? (native = loadNative()) : native);

export const ReactorAudio = {
  get isAvailable(): boolean {
    return getNative() !== null;
  },

  async setMode(mode: ReactorAudioMode): Promise<void> {
    await getNative()?.setMode(mode);
  },

  /** Current output ports — iOS `AVAudioSession.Port` raw values, or
   *  `speaker`/`earpiece`/`wired`/`bluetooth`/`usb` on Android. */
  getRoute(): string[] {
    return getNative()?.getRoute() ?? [];
  },
};
