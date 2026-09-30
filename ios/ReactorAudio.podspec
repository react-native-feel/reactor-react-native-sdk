require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ReactorAudio'
  s.version        = package['version']
  s.summary        = 'Audio-session policy for Reactor streams over react-native-webrtc'
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'react-native-reactor'
  s.homepage       = 'https://docs.reactor.inc'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # The same libwebrtc react-native-webrtc links, so this module configures
  # the one RTCAudioSession that actually plays the stream.
  s.dependency 'JitsiWebRTC'

  s.source_files = '**/*.swift'
end
