import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import {
  ClipDownloadButton,
  ClipPlayer,
  ReactorProvider,
  ReactorView,
  WebcamStream,
  useReactor,
  useReactorMessage,
  useStats,
  type Clip,
} from 'react-native-reactor';

// A JWT, not an API key: exchange your rk_… key for one on your server
// (POST https://api.reactor.inc/tokens) and hand the app only the token.
const DEFAULT_JWT = process.env.EXPO_PUBLIC_REACTOR_JWT ?? '';
const DEFAULT_MODEL = process.env.EXPO_PUBLIC_REACTOR_MODEL ?? 'reactor/echo';

export default function App() {
  const [modelName, setModelName] = useState(DEFAULT_MODEL);
  const [jwt, setJwt] = useState(DEFAULT_JWT);
  const [local, setLocal] = useState(false);
  const [started, setStarted] = useState(false);

  if (!started) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <Text style={styles.title}>Reactor on React Native</Text>
        <Text style={styles.label}>Model</Text>
        <TextInput style={styles.input} value={modelName} onChangeText={setModelName} autoCapitalize="none" />
        <Text style={styles.label}>JWT</Text>
        <TextInput
          style={styles.input}
          value={jwt}
          onChangeText={setJwt}
          autoCapitalize="none"
          secureTextEntry
          placeholder="eyJ…"
          placeholderTextColor="#666"
        />
        <View style={styles.row}>
          <Text style={styles.label}>Local runtime (localhost:8080)</Text>
          <Switch value={local} onValueChange={setLocal} />
        </View>
        <Button title="Open session" onPress={() => setStarted(true)} />
      </View>
    );
  }

  return (
    <ReactorProvider
      modelName={modelName}
      jwtToken={local ? undefined : jwt}
      local={local}
      {...(local ? { apiUrl: 'http://localhost:8080' } : {})}
      connectOptions={{ autoConnect: true }}
      disconnectOnBackground
    >
      <Session onClose={() => setStarted(false)} />
    </ReactorProvider>
  );
}

function Session({ onClose }: { onClose: () => void }) {
  const { status, lastError, sendCommand, reactor, requestClip, disconnect, connect } = useReactor((s) => ({
    status: s.status,
    lastError: s.lastError,
    sendCommand: s.sendCommand,
    reactor: s.internal.reactor,
    requestClip: s.requestClip,
    disconnect: s.disconnect,
    connect: s.connect,
  }));
  const stats = useStats();
  const [prompt, setPrompt] = useState('a forest at dawn');
  const [log, setLog] = useState<string[]>([]);
  const [clip, setClip] = useState<Clip | null>(null);
  useReactorMessage((m) => setLog((l) => [`← ${m.type} ${JSON.stringify(m.data)}`, ...l].slice(0, 20)));

  const sendonly = reactor.tracks().filter((t) => t.direction === 'sendonly');
  const videoIn = sendonly.find((t) => t.kind === 'video');
  const audioIn = sendonly.find((t) => t.kind === 'audio');
  const recvAudio = reactor.tracks().find((t) => t.direction === 'recvonly' && t.kind === 'audio');

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.row}>
        <Text style={styles.title}>{status}</Text>
        <Button title="Close" onPress={() => void disconnect().finally(onClose)} />
      </View>
      {lastError && (
        <Text style={styles.error}>
          {lastError.code}: {lastError.message}
        </Text>
      )}

      <ReactorView
        style={styles.video}
        {...(recvAudio ? { audioTrack: recvAudio.name } : {})}
        placeholder={<Text style={styles.placeholder}>{status === 'ready' ? 'waiting for frames…' : status}</Text>}
      />
      {stats && (
        <Text style={styles.mono}>
          {stats.framesPerSecond?.toFixed(0) ?? '–'} fps · rtt {stats.rtt?.toFixed(0) ?? '–'} ms ·{' '}
          {stats.candidateType ?? '–'} · {((stats.incomingBitrate ?? 0) / 1e6).toFixed(2)} Mbps
        </Text>
      )}

      {videoIn && status === 'ready' && (
        <WebcamStream
          track={videoIn.name}
          {...(audioIn ? { audio: true, audioTrack: audioIn.name } : {})}
          style={styles.webcam}
          onError={(e) => setLog((l) => [`webcam: ${e.message}`, ...l])}
        />
      )}

      <Text style={styles.label}>Command</Text>
      <TextInput style={styles.input} value={prompt} onChangeText={setPrompt} />
      <View style={styles.row}>
        <Button
          title="set_prompt"
          disabled={status !== 'ready'}
          onPress={async () => {
            setLog((l) => [`→ set_prompt ${prompt}`, ...l]);
            const reply = await sendCommand('set_prompt', { prompt });
            if (reply) setLog((l) => [`↩ ${reply.type}`, ...l]);
          }}
        />
        <Button title="start" disabled={status !== 'ready'} onPress={() => void sendCommand('start', {})} />
        <Button
          title="clip 10s"
          disabled={status !== 'ready'}
          onPress={() =>
            requestClip(10)
              .then(setClip)
              .catch((e: Error) => setLog((l) => [`clip: ${e.message}`, ...l]))
          }
        />
        {status === 'disconnected' && <Button title="reconnect" onPress={() => void connect()} />}
      </View>

      {clip && (
        <View style={styles.gap}>
          <ClipPlayer clip={clip} style={styles.video} />
          <ClipDownloadButton clip={clip} onSuccess={(uri) => setLog((l) => [`saved ${uri}`, ...l])} />
        </View>
      )}

      {log.map((line, i) => (
        <Text key={i} style={styles.mono}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

function Button({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#0b0b0c' },
  screen: { flexGrow: 1, backgroundColor: '#0b0b0c', padding: 16, paddingTop: 64, gap: 10 },
  title: { color: '#fff', fontSize: 22, fontWeight: '600', flex: 1 },
  label: { color: '#aaa', fontSize: 13 },
  input: {
    color: '#fff',
    borderColor: '#333',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  gap: { gap: 8 },
  video: { width: '100%', aspectRatio: 16 / 9, borderRadius: 12 },
  webcam: { width: 120, aspectRatio: 3 / 4, borderRadius: 8, alignSelf: 'flex-end' },
  placeholder: { color: '#666', textAlign: 'center', marginTop: '25%' },
  error: { color: '#ff6b6b' },
  mono: { color: '#8fd', fontFamily: 'Menlo', fontSize: 11 },
  button: { backgroundColor: '#1f6feb', paddingHorizontal: 14, minHeight: 44, borderRadius: 8, justifyContent: 'center' },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600' },
});
