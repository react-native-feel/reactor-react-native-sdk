import AVFoundation
import ExpoModulesCore
import WebRTC

/// The audio-session policy of the Reactor Swift SDK's `ReactorMedia`
/// (`Speaker.swift`, `Microphone.swift`), applied to the libwebrtc that
/// react-native-webrtc links.
///
/// ## Why this exists
///
/// A received Reactor audio track is played by libwebrtc's voice-processing
/// audio unit, which needs `.playAndRecord`. Left at libwebrtc's defaults —
/// `.playAndRecord` + `.voiceChat` with no `.defaultToSpeaker` — iOS routes
/// that audio to the **earpiece**: a world model's soundtrack comes out of
/// the part of the phone meant to be held to an ear.
///
/// The Swift SDK does not hit this for playback because its `Speaker` renders
/// PCM through its own `AVAudioEngine` and can ask for `.playback`. Here
/// libwebrtc owns playout, so `.playback` is not available (the voice unit
/// would fail to start); `.videoChat`, which defaults to the speaker, is the
/// nearest honest equivalent. When a microphone is published, the policy is
/// the Swift `Microphone`'s own: `.playAndRecord`, `.voiceChat`,
/// `.defaultToSpeaker`.
///
/// Headphones and Bluetooth still win over the speaker — `.defaultToSpeaker`
/// only changes where audio goes when nothing else is connected.
public class ReactorAudioModule: Module {
  /// libwebrtc's configuration before this module first touched it, so
  /// `setMode("default")` can put it back.
  private static var original: RTCAudioSessionConfiguration?

  public func definition() -> ModuleDefinition {
    Name("ReactorAudio")

    AsyncFunction("setMode") { (mode: String) in
      try Self.apply(mode: mode)
    }

    Function("getRoute") { () -> [String] in
      AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }
    }
  }

  static func apply(mode: String) throws {
    if original == nil {
      original = RTCAudioSessionConfiguration.webRTC()
    }

    let config = RTCAudioSessionConfiguration()
    switch mode {
    case "media":
      config.category = AVAudioSession.Category.playAndRecord.rawValue
      config.mode = AVAudioSession.Mode.videoChat.rawValue
      config.categoryOptions = [.defaultToSpeaker, .allowBluetoothA2DP, .allowAirPlay]
    case "voiceChat":
      config.category = AVAudioSession.Category.playAndRecord.rawValue
      config.mode = AVAudioSession.Mode.voiceChat.rawValue
      config.categoryOptions = [.defaultToSpeaker, .allowBluetooth]
    case "default":
      guard let original else { return }
      config.category = original.category
      config.mode = original.mode
      config.categoryOptions = original.categoryOptions
    default:
      throw Exception(
        name: "ERR_REACTOR_AUDIO_MODE",
        description: "unknown audio mode '\(mode)'; expected media, voiceChat or default")
    }

    // Future activations (a track arriving later) use this configuration…
    RTCAudioSessionConfiguration.setWebRTC(config)

    // …and a session already playing is switched now, rather than on the
    // next connect.
    let session = RTCAudioSession.sharedInstance()
    session.lockForConfiguration()
    defer { session.unlockForConfiguration() }
    if session.isActive {
      try session.setConfiguration(config)
    }
  }
}
