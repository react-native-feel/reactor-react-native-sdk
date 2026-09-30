# react-native-reactor

The [Reactor React SDK](https://docs.reactor.inc/sdk-reference/react-components) on React Native:
`ReactorProvider`, `ReactorView`, `WebcamStream`, `ClipPlayer`, `ClipDownloadButton`, `useReactor`,
`useReactorMessage` and the `Reactor` class, with the same names, props and events, rendered with
React Native views and `StyleSheet` styles.

```tsx
import { ReactorProvider, ReactorView, useReactor } from 'react-native-reactor';

export default function App() {
  return (
    <ReactorProvider modelName="reactor/helios" jwtToken={getJwt} connectOptions={{ autoConnect: true }}>
      <ReactorView style={{ width: '100%', aspectRatio: 16 / 9 }} />
      <Prompt />
    </ReactorProvider>
  );
}

function Prompt() {
  const { status, sendCommand } = useReactor((s) => ({ status: s.status, sendCommand: s.sendCommand }));
  return <Button disabled={status !== 'ready'} title="Dawn" onPress={() => sendCommand('set_prompt', { prompt: 'a forest at dawn' })} />;
}
```

## Install (Expo, development build)

```sh
npx expo install react-native-reactor react-native-webrtc @config-plugins/react-native-webrtc
npx expo install expo-video expo-file-system   # optional: ClipPlayer / clip downloads
```

```json
// app.json
{ "plugins": [["react-native-reactor", {
  "cameraPermission": "Streams your camera to the world model you are steering.",
  "microphonePermission": "Streams your voice to the world model you are steering."
}]] }
```

Then `npx expo run:ios` / `run:android`. WebRTC is native code, so Expo Go cannot run it.

**Auth**: as on the web, never ship the `rk_…` API key. Exchange it for a JWT on your server
(`POST https://api.reactor.inc/tokens`) and pass the JWT, or a function that fetches one, as `jwtToken`.

## How it is built, and why

Every Reactor SDK is a thin shell around one Rust core (`reactor-core`: session lifecycle, HTTP
signaling, the `reactor_wire.v1` protobuf channels, recording). The browser SDK loads that core as
**WebAssembly**, and Swift, Python, C++ and Java load it through `reactor-ffi`. Neither path works in React Native:

| Option | Verdict |
|---|---|
| Reuse `@reactor-team/js-sdk` | ✗ Its core is wasm, and Hermes has no `WebAssembly`. |
| Wrap the Swift SDK (`ReactorFFI.xcframework`) in a native module | ✗ The XCFramework statically links its own libwebrtc, which collides with any other WebRTC in the app. It is iOS only (no Android build of `reactor-ffi` is published), and frames arrive as BGRA buffers that would need a custom renderer. |
| **Port the core to TypeScript, and use `react-native-webrtc` as the media engine** | ✓ This is the route story-smash-director's Director stream already runs in production: `registerGlobals()` or an injected engine, `RTCView` + `stream.toURL()`. |

So this package is:

- **`src/core/`**, a TypeScript port of `reactor-core`'s `reactor.rs` (the state machine),
  `coordinator.rs`/`signaling.rs` (HTTP), `control.rs`/`data.rs` (correlation), and
  `reactor-wasm/src/peer.rs` (the `PeerTransport`, written against a W3C-shaped engine so
  `react-native-webrtc`, a browser or a test fake all fit). The file structure follows the Rust
  closely, so an upstream fix has an obvious place to land.
- **`src/core/wire.ts`**, a zero-dependency protobuf codec for `reactor_wire.v1`. The `.proto`
  files are vendored in `proto/` at the same pinned release the Rust crate builds against, and the tests
  compare every message byte-for-byte with `protoc --encode`.
- **`src/reactor.ts`, `src/react/`**: the JS SDK's `Reactor` class, store, provider and hooks,
  carried over almost verbatim (Apache-2.0, see `NOTICE`), plus RN versions of the components.
- **`ios/`, `android/`**: one small Expo module, `ReactorAudio`, the part worth bringing over from
  the Swift SDK (see below).

## API differences from the React SDK

Everything not listed here is the same.

| | React (web) | React Native |
|---|---|---|
| Styling | `className`, `style: CSSProperties` | `style: StyleProp<ViewStyle>` |
| `ReactorView.videoObjectFit` | any CSS `object-fit` | `contain` / `cover` (`fill` → cover, others → contain) |
| `ReactorView` extras | none | `mirror`, `zOrder`, `placeholder` |
| `ReactorView.muted` | mutes the `<video>` element | disables `audioTrack` itself. On a phone every received audio track plays through the device even if no view names it; use `pauseTrack()` to stop one at the source. |
| `WebcamStream.videoConstraints` | `MediaTrackConstraints` | `{ width, height, frameRate, facingMode, deviceId }`. `mirror` defaults to true for the front camera (preview only). |
| Permission denied | `NotAllowedError` | `NotAllowedError` or `SecurityError`, both mapped to `onPermissionDenied` |
| `uploadFile(file)` | `File \| Blob` | `Blob \| ArrayBuffer \| Uint8Array \| { uri, name?, type? }` (what image pickers return) |
| `downloadClipAsFile`, `ClipDownloadButton.onSuccess`, `useClipDownload().download` | a `Blob`, plus a browser download | a `file://` URI in the cache directory (needs `expo-file-system`) |
| `ClipPlayer` | hls.js / MSE | `expo-video`; with a JWT it downloads the clip first (`strategy="download"`), because the player would forward the coordinator's `Authorization` header to the presigned segment URLs |
| Downloaded clip | remuxed to flat MP4 (mp4box) | concatenated fragmented MP4, which AVPlayer and ExoPlayer play directly |
| `reactor[Symbol.dispose]()` | ✓ | `reactor.dispose()`; `Symbol.dispose` too where the engine defines it |
| `ReactorProvider` extras | none | `audioMode` (default `"media"`), `disconnectOnBackground`, `deps` |
| `Reactor` constructor | `new Reactor(options)` | `new Reactor(options, deps?)`, where `deps` can swap the WebRTC engine or `fetch` |

`client_info.sdk_type` is reported as `react-native`.

## Native code: what came from the Swift SDK

Only the audio-session policy. Received audio on React Native plays through libwebrtc's
voice-processing unit as call audio, and both iOS (`.playAndRecord` + `.voiceChat`) and Android
(`MODE_IN_COMMUNICATION`) route call audio to the **earpiece**. The Swift SDK's `ReactorMedia`
sets the session up for media playback, and `ReactorAudio` applies the same policy to the libwebrtc
that `react-native-webrtc` links:

- `"media"` (the provider's default while connected): speaker unless headphones or Bluetooth are
  connected. On iOS this is `.playAndRecord` + `.videoChat` + `.defaultToSpeaker`. The Swift `Speaker`'s
  `.playback` is not possible here because libwebrtc, not an `AVAudioEngine`, owns playout.
- `"voiceChat"`: the Swift `Microphone`'s `.playAndRecord` + `.voiceChat` + `.defaultToSpeaker`,
  for publishing a mic.
- `"default"`: hands the session back to libwebrtc.

```ts
import { ReactorAudio } from 'react-native-reactor';
await ReactorAudio.setMode('voiceChat');
```

Things deliberately **not** brought over: the Swift SDK's raw frame access (`track.onFrame` with BGRA
pixels) and frame metadata. Getting pixels out of `react-native-webrtc` needs a native video sink.
If a model's client needs per-frame data, that is the next native module to write.

## Example

`example/` is an Expo app covering connect, `ReactorView`, commands, `WebcamStream` for models with a
sendonly track, clips, and live stats:

```sh
cd example && npm install
EXPO_PUBLIC_REACTOR_JWT=eyJ… EXPO_PUBLIC_REACTOR_MODEL=reactor/helios npx expo run:ios
```

## Development

```sh
npm install
npm run typecheck
npm test          # 74 tests: wire codec vs protoc, orchestrator vs a fake runtime, Reactor, store, recording
```

To adopt a newer wire protocol, replace `proto/` with the release named in reactor-client-sdks'
`crates/reactor-protocol/proto/WIRE_VERSION`, run the tests (they re-check against `protoc`), and
extend `src/core/wire.ts` for any new fields.
