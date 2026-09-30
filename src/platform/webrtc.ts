/**
 * The default media engine: `react-native-webrtc`.
 *
 * Required lazily, on first connect, rather than imported at module scope:
 * importing the SDK (for its types, its hooks, a test) should not load a
 * native module, and a missing one should fail with a sentence that says what
 * to install rather than a red screen about `WebRTCModule`.
 */
import type { WebRTCImplementation } from '../core/peer';

declare const require: (id: string) => any;

let cached: WebRTCImplementation | undefined;

export function reactNativeWebRTC(): WebRTCImplementation {
  if (cached) {
    return cached;
  }
  let module: any;
  try {
    module = require('react-native-webrtc');
  } catch (cause) {
    throw new Error(
      'react-native-reactor needs react-native-webrtc: `npx expo install react-native-webrtc ' +
        '@config-plugins/react-native-webrtc` and rebuild the dev client (it is native code, so ' +
        'Expo Go cannot load it).',
      { cause },
    );
  }
  cached = { RTCPeerConnection: module.RTCPeerConnection, MediaStream: module.MediaStream };
  return cached;
}
