/**
 * Expo config plugin for react-native-reactor.
 *
 *   plugins: [["react-native-reactor", {
 *     cameraPermission: "Streams your camera to the world model you are steering.",
 *     microphonePermission: "Streams your voice to the world model you are steering."
 *   }]]
 *
 * Wraps @config-plugins/react-native-webrtc, which declares the Android
 * permissions WebRTC needs and writes the iOS usage descriptions. That plugin
 * ALWAYS writes NSCameraUsageDescription, and its fallback is the placeholder
 * "Allow $(PRODUCT_NAME) to access your camera" — a review flag, and untrue
 * for an app that only watches a model. So this plugin passes a real sentence
 * for both, and yours wins when you give one. (story-smash found this in its
 * generated Info.plist; the same holds for any receive-only Reactor app.)
 */
const withWebRTC = require('@config-plugins/react-native-webrtc').default;

const DEFAULT_CAMERA =
  'Lets you stream your camera to a live world model, when you choose to.';
const DEFAULT_MICROPHONE =
  'Lets you stream your voice to a live world model, when you choose to.';

function withReactor(config, props = {}) {
  const { cameraPermission, microphonePermission } = props || {};
  return withWebRTC(config, {
    cameraPermission: cameraPermission || DEFAULT_CAMERA,
    microphonePermission: microphonePermission || DEFAULT_MICROPHONE,
  });
}

module.exports = withReactor;
