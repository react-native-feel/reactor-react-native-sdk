import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileRef } from '../src/file-ref';
import { Reactor } from '../src/reactor';
import { UnauthorizedError, InvalidStateError, ReactorError } from '../src/errors';
import { createReactorStore } from '../src/react/store';
import { absolutizeManifest, fetchPlaylist, parsePlaylist, resolveAgainst, RecordingError } from '../src/recording';
import { FakePlatform, FakeTrack, flush } from './fakes';

function makeReactor(platform = new FakePlatform(), options: Record<string, unknown> = {}) {
  return new Reactor(
    { modelName: 'reactor/demo', jwt: 'jwt-token', heartbeatIntervalMs: 0, ...options },
    { webrtc: platform.webrtc, http: platform.http, wait: () => Promise.resolve() },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Reactor', () => {
  it('connects, exposes public camelCase shapes, and fetches the schema on ready', async () => {
    const platform = new FakePlatform();
    const reactor = makeReactor(platform);
    const events: string[] = [];
    const received: string[] = [];
    reactor.on('statusChanged', (s) => events.push(s));
    reactor.on('trackReceived', (name, track, stream) => {
      received.push(name);
      expect(track).toBeDefined();
      expect(typeof (stream as unknown as { toURL: () => string }).toURL()).toBe('string');
    });
    const schema = new Promise((resolve) => reactor.once('schemaReceived', resolve));

    await reactor.connect();

    expect(events).toEqual(['connecting', 'waiting', 'ready']);
    expect(received).toEqual(['main_video', 'main_audio']);
    expect(reactor.getStatus()).toBe('ready');
    expect(reactor.getCapabilities()).toEqual({
      protocolVersion: '1.0',
      tracks: platform.tracks,
      emissionFps: 24,
    });
    expect(await schema).toEqual({ openapi: '3.1.0', info: { title: 'fake', version: '1' } });
    expect(reactor.getSchema()).toEqual({ openapi: '3.1.0', info: { title: 'fake', version: '1' } });
    const timings = reactor.getConnectionTimings()!;
    expect(timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(timings.totalMs).toBeCloseTo(timings.sessionCreationMs + timings.transportConnectingMs, 5);
    await reactor.disconnect();
    expect(reactor.getStatus()).toBe('disconnected');
    expect(reactor.getCapabilities()).toBeUndefined();
  });

  it('throws typed errors from connect()', async () => {
    const platform = new FakePlatform();
    const original = platform.http;
    (platform as { http: typeof original }).http = async (r) =>
      r.url.endsWith('/sessions') && r.method === 'POST'
        ? { status: 403, header: () => undefined, text: async () => 'nope' }
        : original(r);
    const reactor = makeReactor(platform);
    const error = await reactor.connect().catch((e) => e);
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toBeInstanceOf(ReactorError);
    expect(reactor.getLastError()).toBe(error);
  });

  it('sendCommand never rejects: failures go to the error event', async () => {
    const reactor = makeReactor();
    const errors: ReactorError[] = [];
    reactor.on('error', (e) => errors.push(e));
    await expect(reactor.sendCommand('set_prompt', { prompt: 'x' })).resolves.toBeUndefined();
    expect(errors[0]).toBeInstanceOf(InvalidStateError);
    expect(errors[0]!.operation).toBe('sendCommand');
  });

  it('moves a top-level FileRef into uploads and rewrites nested ones', async () => {
    const platform = new FakePlatform();
    const reactor = makeReactor(platform);
    await reactor.connect();
    const image = new FileRef('up_1', 'a.png', 'image/png', 3);
    const other = new FileRef('up_2', 'b.png', 'image/png', 4);
    await reactor.sendCommand('set_images', { image, gallery: [other], strength: 1 });
    expect(platform.dataReceived.at(-1)!.payload).toEqual({
      case: 'command',
      value: {
        type: 'set_images',
        data: {
          strength: 1,
          gallery: [{ upload_id: 'up_2', name: 'b.png', mime_type: 'image/png', size: 4 }],
        },
        uploads: { image: { upload_id: 'up_1', name: 'a.png', mime_type: 'image/png', size: 3 } },
      },
    });
  });

  it('uploads a { uri } by reading it through fetch', async () => {
    const platform = new FakePlatform();
    const reactor = makeReactor(platform);
    await reactor.connect();
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
    vi.stubGlobal('fetch', async (uri: string) => {
      expect(uri).toBe('file:///tmp/photo.jpg');
      return { blob: async () => blob };
    });
    const ref = await reactor.uploadFile({ uri: 'file:///tmp/photo.jpg' });
    expect(ref).toBeInstanceOf(FileRef);
    expect(ref).toMatchObject({ uploadId: 'up_1', name: 'photo.jpg', mimeType: 'image/jpeg', size: 4 });
    expect(platform.uploaded[0]!.body).toBe(blob);
  });

  it('uploads raw bytes with an explicit name and type', async () => {
    const platform = new FakePlatform();
    const reactor = makeReactor(platform);
    await reactor.connect();
    const ref = await reactor.uploadFile(new Uint8Array([9, 9]), { name: 'x.bin', mimeType: 'application/x-test' });
    expect(ref).toMatchObject({ name: 'x.bin', mimeType: 'application/x-test', size: 2 });
  });

  it('publishes a local track and bounds its bitrate', async () => {
    const platform = new FakePlatform();
    const reactor = makeReactor(platform);
    await reactor.connect();
    const camera = new FakeTrack('video');
    await reactor.publishTrack('webcam', camera as never);
    await reactor.setTrackBitrate('webcam', { maxBps: 4_000_000 });
    expect(platform.pc.transceivers[2]!.sender.track).toBe(camera);
    expect(platform.pc.transceivers[2]!.sender.applied.at(-1)).toEqual({ maxBitrate: 4_000_000, minBitrate: null });
    await reactor.unpublishTrack('webcam');
    expect(platform.pc.transceivers[2]!.sender.track).toBeNull();
  });

  it('turns clips into the public shape, for calls and runtime events alike', async () => {
    const reactor = makeReactor();
    await reactor.connect();
    const runtime: unknown[] = [];
    reactor.on('runtimeMessage', (m) => runtime.push(m));
    const clip = await reactor.requestClip(5);
    expect(clip).toEqual({
      sessionId: 'sess_1',
      kind: 'snap',
      startMarker: 0,
      endMarker: 5,
      nowMarker: 5,
      predictedReadyAtMs: 1_800_000_000_000,
      playlistUrl: 'https://api.reactor.inc/sessions/sess_1/clips/c1.m3u8',
    });
    expect(runtime).toContainEqual({ type: 'clipReady', data: clip });
  });

  it('samples connection stats every 2s while ready', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const reactor = makeReactor();
    const samples: unknown[] = [];
    reactor.on('statsUpdate', (s) => samples.push(s));
    await reactor.connect();
    vi.advanceTimersByTime(2000);
    await flush();
    expect(samples).toHaveLength(1);
    expect(reactor.getStats()).toMatchObject({ rtt: 50, candidateType: 'relay' });
    await reactor.disconnect();
    expect(reactor.getStats()).toBeUndefined();
  });

  it('reconnects on the same session after a dropped peer', async () => {
    const platform = new FakePlatform();
    const reactor = makeReactor(platform);
    await reactor.connect();
    platform.pc.setState('disconnected');
    await flush();
    expect(reactor.getStatus()).toBe('disconnected');
    expect(reactor.getSessionId()).toBe('sess_1');
    await reactor.reconnect();
    expect(reactor.getStatus()).toBe('ready');
  });

  it('is unusable after dispose()', async () => {
    const reactor = makeReactor();
    reactor.dispose();
    await expect(reactor.connect()).rejects.toThrow(/disposed/);
  });

  it('serializes a disconnect behind an in-flight connect', async () => {
    const platform = new FakePlatform();
    const reactor = makeReactor(platform);
    const connecting = reactor.connect();
    const disconnecting = reactor.disconnect();
    await connecting;
    await disconnecting;
    expect(reactor.getStatus()).toBe('disconnected');
    expect(platform.sessionDeleted).toBe(true);
  });
});

describe('store', () => {
  it('mirrors status, session, messages and tracks, and resets tracks on disconnect', async () => {
    const platform = new FakePlatform();
    const store = createReactorStore(
      { modelName: 'm', heartbeatIntervalMs: 0 },
      { autoResumeTracks: true },
      { webrtc: platform.webrtc, http: platform.http, wait: () => Promise.resolve() },
    );
    await store.getState().connect();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().sessionId).toBe('sess_1');
    expect(Object.keys(store.getState().tracks)).toEqual(['main_video', 'main_audio']);
    await store.getState().sendCommand('ping_model', { n: 1 });
    expect(store.getState().lastMessage).toEqual({ type: 'echo', data: { n: 1 } });
    await store.getState().disconnect();
    expect(store.getState().tracks).toEqual({});
    expect(store.getState().status).toBe('disconnected');
  });
});

describe('recording helpers', () => {
  it('resolves playlist references the way a browser URL does', () => {
    const base = 'https://api.reactor.inc/sessions/s/clips/c1.m3u8?token=x';
    const cases = [
      'seg0.m4s',
      './seg0.m4s',
      '../other/seg.m4s',
      '/root/seg.m4s',
      'https://bucket.s3.amazonaws.com/a/b.m4s?X-Amz-Signature=1',
      '//cdn.example.com/x.m4s',
      'seg.m4s?part=2',
    ];
    for (const target of cases) {
      expect(resolveAgainst(target, base)).toBe(new URL(target, base).toString());
    }
  });

  it('parses an fMP4 playlist and absolutizes it', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:2.0,',
      'seg0.m4s',
      '#EXTINF:2.0,',
      'https://s3.example.com/seg1.m4s?sig=1',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const url = 'https://api.reactor.inc/clips/c1.m3u8';
    expect(parsePlaylist(manifest, url)).toEqual({
      initUrl: 'https://api.reactor.inc/clips/init.mp4',
      segmentUrls: ['https://api.reactor.inc/clips/seg0.m4s', 'https://s3.example.com/seg1.m4s?sig=1'],
    });
    expect(absolutizeManifest(manifest, url)).toContain('#EXT-X-MAP:URI="https://api.reactor.inc/clips/init.mp4"');
    expect(() => parsePlaylist('#EXTM3U\nseg.m4s', url)).toThrow(RecordingError);
  });

  it('polls a 202 playlist with the JWT until it is ready', async () => {
    const responses = [202, 202, 200];
    const seen: Array<Record<string, string> | undefined> = [];
    vi.stubGlobal('fetch', async (_url: string, init: { headers?: Record<string, string> }) => {
      seen.push(init.headers);
      const status = responses.shift()!;
      return {
        status,
        headers: { get: (name: string) => (name === 'Retry-After' ? '0' : null) },
        text: async () => '#EXTM3U',
      };
    });
    await expect(fetchPlaylist('https://x/p.m3u8', { jwt: 't', minRetryDelayMs: 0 })).resolves.toBe('#EXTM3U');
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ Authorization: 'Bearer t' });
  });

  it('reports a gone clip', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 410, headers: { get: () => null }, text: async () => '' }));
    await expect(fetchPlaylist('https://x/p.m3u8')).rejects.toMatchObject({ code: 'CLIP_GONE' });
  });
});
