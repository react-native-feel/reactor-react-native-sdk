package inc.reactor.rn

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android half of the audio policy (see ios/ReactorAudioModule.swift).
 *
 * libwebrtc plays received audio as a voice-communication stream, and Android
 * routes that stream by the AudioManager's communication device — the
 * earpiece, unless told otherwise. "media" and "voiceChat" both enter
 * communication mode and pick the best output: a headset if one is
 * connected, the loudspeaker if not. "default" hands routing back.
 */
class ReactorAudioModule : Module() {
  private val audioManager: AudioManager
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      ?: throw CodedException("ERR_REACTOR_AUDIO_UNAVAILABLE", "AudioManager is not available", null)

  override fun definition() = ModuleDefinition {
    Name("ReactorAudio")

    AsyncFunction("setMode") { mode: String ->
      apply(mode)
    }

    Function("getRoute") {
      val manager = audioManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        listOfNotNull(manager.communicationDevice?.let { typeName(it.type) })
      } else {
        @Suppress("DEPRECATION")
        listOf(if (manager.isSpeakerphoneOn) "speaker" else "default")
      }
    }
  }

  private fun apply(mode: String) {
    val manager = audioManager
    when (mode) {
      "media", "voiceChat" -> {
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        routeToPreferredOutput(manager)
      }
      "default" -> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          manager.clearCommunicationDevice()
        } else {
          @Suppress("DEPRECATION")
          manager.isSpeakerphoneOn = false
        }
        manager.mode = AudioManager.MODE_NORMAL
      }
      else -> throw CodedException(
        "ERR_REACTOR_AUDIO_MODE",
        "unknown audio mode '$mode'; expected media, voiceChat or default",
        null,
      )
    }
  }

  /** A connected headset first — what the person chose to listen on — and the
   *  loudspeaker only when there is none. Never the earpiece. */
  private fun routeToPreferredOutput(manager: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val preference = listOf(
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
      )
      val available = manager.availableCommunicationDevices
      val device = preference.firstNotNullOfOrNull { type -> available.firstOrNull { it.type == type } }
      if (device != null) {
        manager.setCommunicationDevice(device)
      }
    } else {
      val outputs = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      val headset = outputs.any {
        it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
          it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
          it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
          it.type == AudioDeviceInfo.TYPE_USB_HEADSET
      }
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = !headset
    }
  }

  private fun typeName(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
    else -> "other"
  }
}
