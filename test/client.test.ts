import { describe, expect, it, vi } from 'vitest';
import { ReactorClient, type ClientOptions } from '../src/core/client';
import { MessageKind, decodeControlClientMessage } from '../src/core/wire';
import { FakePlatform, FakeTrack, flush } from './fakes';

const noWait = () => Promise.resolve();

function setup(options: Partial<ClientOptions> = {}, platform = new FakePlatform()) {
  const client = new ReactorClient(
    { modelName: 'reactor/demo', sdkVersion: '0.1.0', heartbeatIntervalMs: 0, ...options },
    'jwt-token',
    { webrtc: platform.webrtc, http: platform.http, wait: noWait },
  );
  const statuses: string[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  const messages: unknown[] = [];
  const runtime: unknown[] = [];
  const tracks: Array<[string, string | undefined]> = [];
  const sessionIds: Array<string | undefined> = [];
  client.on('statusChanged', (s) => statuses.push(s));
  client.on('error', (e) => errors.push({ code: e.code, message: e.message }));
  client.on('message', (m) => messages.push(m));
  client.on('runtimeMessage', (m) => runtime.push(m));
  client.on('trackReceived', (name, mid) => tracks.push([name, mid]));
  client.on('sessionIdChanged', (id) => sessionIds.push(id));
  return { client, platform, statuses, errors, messages, runtime, tracks, sessionIds };
}

describe('connect', () => {
  it('walks connecting → waiting → ready and negotiates the declared tracks', async () => {
    const { client, platform, statuses, tracks, sessionIds } = setup();
    let capabilities: unknown;
    client.on('capabilitiesReceived', (c) => (capabilities = c));

    await client.connect();

    expect(statuses).toEqual(['connecting', 'waiting', 'ready']);
    expect(client.status()).toBe('ready');
    expect(client.sessionId()).toBe('sess_1');
    expect(sessionIds).toEqual(['sess_1']);
    expect(capabilities).toMatchObject({ protocol_version: '1.0', emission_fps: 24 });

    // Session creation says who is asking, and how.
    const create = platform.requests.find((r) => r.method === 'POST' && r.url.endsWith('/sessions'))!;
    expect(JSON.parse(create.body as string)).toEqual({
      model: { name: 'reactor/demo' },
      client_info: { sdk_version: '0.1.0', sdk_type: 'react-native' },
      supported_transports: [{ protocol: 'webrtc', version: '1.0' }],
    });
    expect(create.headers).toMatchObject({
      Authorization: 'Bearer jwt-token',
      'Reactor-API-Version': '1',
      'Reactor-API-Accept-Version': '1',
    });

    // ICE servers become an RTCConfiguration, TURN credentials included.
    expect(platform.pc.configuration.iceServers).toEqual([
      { urls: ['stun:stun.example.com:3478'] },
      { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' },
    ]);

    // Channels: control first, then data — the order old runtimes rely on.
    expect(platform.pc.channels.map((c) => c.label)).toEqual(['control', 'data']);
    expect(platform.pc.channels.every((c) => c.binaryType === 'arraybuffer')).toBe(true);

    // One transceiver per track, in order; the offer maps names to mids.
    const offer = platform.requests.find((r) => r.method === 'POST' && r.url.endsWith('/sdp_params'))!;
    expect(offer.headers['Reactor-WebRTC-Version']).toBe('1.0');
    expect(JSON.parse(offer.body as string)).toEqual({
      sdp_offer: 'v=0 fake offer with 3 m-lines',
      client_info: { sdk_version: '0.1.0', sdk_type: 'react-native' },
      track_mapping: [
        { name: 'main_video', kind: 'video', direction: 'recvonly', mid: '0' },
        { name: 'main_audio', kind: 'audio', direction: 'recvonly', mid: '1' },
        { name: 'webcam', kind: 'video', direction: 'sendonly', mid: '2' },
      ],
    });
    expect(platform.pc.remoteSdp).toBe('v=0 fake answer');

    // Received tracks are resolved to names through the mapping.
    expect(tracks).toEqual([
      ['main_video', '0'],
      ['main_audio', '1'],
    ]);
    expect(client.getStreamByName('main_video')?.getVideoTracks()).toHaveLength(1);
    expect(client.getTrackByName('webcam')).toBeUndefined();
  });

  it('trickles ICE once the connection is registered, and marks the final batch', async () => {
    const { client, platform } = setup();
    await client.connect();
    await flush();
    const batches = platform.requests
      .filter((r) => r.url.endsWith('/ice_candidates'))
      .map((r) => JSON.parse(r.body as string));
    const all = batches.flatMap((b) => b.candidates);
    expect(all).toEqual([{ candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdp_mid: '0', sdp_mline_index: 0 }]);
    expect(batches.filter((b) => b.is_final)).toHaveLength(1);
    expect(batches.at(-1)!.is_final).toBe(true);
  });

  it('auto-resumes the recvonly tracks once ready', async () => {
    const { client, platform } = setup();
    await client.connect();
    const resumed = platform.controlReceived
      .filter((m) => m.payload?.case === 'resume_track')
      .map((m) => (m.payload as { value: { name: string } }).value.name);
    expect(resumed).toEqual(['main_video', 'main_audio']);
    expect(platform.controlReceived.every((m) => m.kind === MessageKind.Notification)).toBe(true);
  });

  it('skips auto-resume when asked to', async () => {
    const { client, platform } = setup();
    await client.connect({ autoResumeTracks: false });
    expect(platform.controlReceived.filter((m) => m.payload?.case === 'resume_track')).toHaveLength(0);
  });

  it('refuses a second connect while connected', async () => {
    const { client } = setup();
    await client.connect();
    await expect(client.connect()).rejects.toMatchObject({ code: 'INVALID_STATE', operation: 'connect' });
  });

  it('fails with the HTTP status mapped to a typed code, and tears down', async () => {
    const platform = new FakePlatform();
    const original = platform.http;
    (platform as { http: typeof original }).http = async (request) =>
      request.url.endsWith('/sessions') && request.method === 'POST'
        ? { status: 401, header: () => undefined, text: async () => 'expired' }
        : original(request);
    const { client, statuses, errors } = setup({}, platform);
    await expect(client.connect()).rejects.toMatchObject({
      name: 'ReactorError',
      code: 'UNAUTHORIZED',
      status: 401,
      recoverable: false,
      operation: 'connect',
    });
    expect(errors[0]?.code).toBe('UNAUTHORIZED');
    expect(statuses.at(-1)).toBe('disconnected');
  });

  it('gives up polling after the attempt limit with REQUEST_TIMEOUT', async () => {
    const platform = new FakePlatform({ pendingPolls: 1000 });
    const { client } = setup({ maxSessionAttempts: 3 }, platform);
    await expect(client.connect()).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', recoverable: true });
    expect(platform.requests.filter((r) => r.method === 'GET' && r.url.endsWith('/sessions/sess_1'))).toHaveLength(3);
  });

  it('adopts an existing session without creating (or later deleting) one', async () => {
    const { client, platform } = setup();
    await client.connect({ sessionId: 'sess_1' });
    expect(platform.requests.some((r) => r.method === 'POST' && r.url.endsWith('/sessions'))).toBe(false);
    await client.disconnect();
    expect(platform.sessionDeleted).toBe(false);
  });

  it('builds the offer in parallel when tracks are preset, and rejects a mismatch', async () => {
    const good = setup({
      modelTracks: [
        { name: 'webcam', kind: 'video', direction: 'sendonly' },
        { name: 'main_video', kind: 'video', direction: 'recvonly' },
        { name: 'main_audio', kind: 'audio', direction: 'recvonly' },
      ],
    });
    await good.client.connect();
    expect(good.client.status()).toBe('ready');

    const bad = setup({ modelTracks: [{ name: 'main_video', kind: 'video', direction: 'recvonly' }] });
    await expect(bad.client.connect()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(bad.platform.requests.some((r) => r.url.endsWith('/sdp_params'))).toBe(false);
  });

  it('times out waiting for transport readiness', async () => {
    const platform = new FakePlatform();
    platform.stallTransport = true;
    const { client } = setup({ readyTimeoutMs: 20 }, platform);
    await expect(client.connect()).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(client.status()).toBe('disconnected');
  });
});

describe('commands', () => {
  it('correlates a reply, and also broadcasts it as a message event', async () => {
    const { client, platform, messages } = setup();
    await client.connect();
    const reply = await client.sendCommand('set_prompt', { prompt: 'a forest', strength: 0.5 }, undefined);
    expect(reply).toEqual({ type: 'echo', data: { prompt: 'a forest', strength: 0.5 } });
    expect(messages).toEqual([reply]);
    const sent = platform.dataReceived.at(-1)!;
    expect(sent.request_id).toBe('data_1');
    expect(sent.kind).toBe(MessageKind.Request);
  });

  it('resolves undefined for a bodyless acknowledgement', async () => {
    const { client, platform } = setup();
    platform.onCommand = () => undefined;
    await client.connect();
    await expect(client.sendCommand('start', {}, undefined)).resolves.toBeUndefined();
  });

  it('rejects with the runtime code, without also raising an error event', async () => {
    const { client, platform, errors } = setup();
    platform.onCommand = () => ({ case: 'error', value: { code: 'INVALID_ARGS', message: 'prompt required' } });
    await client.connect();
    await expect(client.sendCommand('set_prompt', {}, undefined)).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      message: "command 'set_prompt' failed (INVALID_ARGS): prompt required",
    });
    expect(errors).toEqual([]);
  });

  it('times out a command nobody answers', async () => {
    const { client, platform } = setup({ controlRequestTimeoutMs: 15 });
    platform.onCommand = () => 'silent';
    await client.connect();
    await expect(client.sendCommand('slow', {}, undefined)).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });

  it('rejects a message over the SCTP limit before it reaches the wire', async () => {
    const { client, platform } = setup();
    await client.connect();
    const before = platform.dataReceived.length;
    await expect(
      client.sendCommand('huge', { blob: 'x'.repeat(300 * 1024) }, undefined),
    ).rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' });
    expect(platform.dataReceived.length).toBe(before);
  });

  it('requires ready', async () => {
    const { client } = setup();
    await expect(client.sendCommand('x', {}, undefined)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      operation: 'sendCommand',
    });
  });

  it('carries uploads as upload references', async () => {
    const { client, platform } = setup();
    await client.connect();
    await client.sendCommand('set_image', { strength: 1 }, {
      image: { upload_id: 'up_1', name: 'a.png', mime_type: 'image/png', size: 3 },
    });
    const command = platform.dataReceived.at(-1)!.payload;
    expect(command).toEqual({
      case: 'command',
      value: {
        type: 'set_image',
        data: { strength: 1 },
        uploads: { image: { upload_id: 'up_1', name: 'a.png', mime_type: 'image/png', size: 3 } },
      },
    });
  });

  it('dispatches unprompted model messages and errors', async () => {
    const { client, platform, messages, errors } = setup();
    await client.connect();
    platform.pushData({ case: 'message', value: { type: 'progress', data: { frame: 3 } } });
    platform.pushData({ case: 'error', value: { code: 'MODEL_ERROR', message: 'oom' } });
    await flush();
    expect(messages).toEqual([{ type: 'progress', data: { frame: 3 } }]);
    expect(errors).toEqual([{ code: 'MODEL_ERROR', message: 'oom' }]);
  });

  it('fetches the model schema over the control channel', async () => {
    const { client } = setup();
    await client.connect();
    await expect(client.requestSchema()).resolves.toEqual({ openapi: '3.1.0', info: { title: 'fake', version: '1' } });
  });
});

describe('tracks', () => {
  it('publishes: claims the slot, then attaches the media', async () => {
    const { client, platform } = setup();
    await client.connect();
    const camera = new FakeTrack('video');
    await client.publishTrack('webcam', camera);
    const request = platform.controlReceived.find((m) => m.payload?.case === 'publish_track')!;
    expect(request.kind).toBe(MessageKind.Request);
    expect(request.request_id).toMatch(/^ctrl_\d+$/);
    expect(platform.pc.transceivers[2]!.sender.track).toBe(camera);
  });

  it('a refused publish leaves the sender empty and reports the runtime code', async () => {
    const { client, platform, errors } = setup();
    platform.onControl = () => ({ case: 'error', value: { code: 'TRACK_BUSY', message: 'taken' } });
    await client.connect();
    await expect(client.publishTrack('webcam', new FakeTrack('video'))).rejects.toMatchObject({
      code: 'TRACK_BUSY',
      operation: 'publishTrack',
    });
    expect(platform.pc.transceivers[2]!.sender.track).toBeNull();
    expect(errors.map((e) => e.code)).toEqual(['TRACK_BUSY']);
  });

  it('unpublishes with a notification and detaches the media', async () => {
    const { client, platform } = setup();
    await client.connect();
    await client.publishTrack('webcam', new FakeTrack('video'));
    await client.unpublishTrack('webcam');
    expect(platform.controlReceived.at(-1)!.payload).toEqual({ case: 'unpublish_track', value: { name: 'webcam' } });
    expect(platform.pc.transceivers[2]!.sender.track).toBeNull();
  });

  it('pauses and resumes a received track by flipping its transceiver', async () => {
    const { client, platform } = setup();
    await client.connect({ autoResumeTracks: false });
    const video = platform.pc.transceivers[0]!;
    await client.pauseTrack('main_video');
    expect(video.direction).toBe('inactive');
    expect(client.pausedTracks()).toEqual(['main_video']);
    await client.resumeTrack('main_video');
    expect(video.direction).toBe('recvonly');
    expect(client.pausedTracks()).toEqual([]);
    expect(platform.controlReceived.map((m) => m.payload?.case)).toEqual(['pause_track', 'resume_track']);
  });

  it('bounds a sender bitrate, and keeps the bound across a reconnect', async () => {
    const { client, platform } = setup();
    await client.connect();
    await client.setTrackBitrate('webcam', undefined, 8_000_000);
    expect(platform.pc.transceivers[2]!.sender.applied).toEqual([{ maxBitrate: 8_000_000, minBitrate: null }]);
    await expect(client.setTrackBitrate('nope', undefined, 1)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    await client.reconnect();
    expect(platform.connections).toHaveLength(2);
    expect(platform.pc.transceivers[2]!.sender.applied).toEqual([{ maxBitrate: 8_000_000, minBitrate: null }]);
  });
});

describe('recording', () => {
  it('resolves a clip and absolutizes a relative playlist url', async () => {
    const { client, runtime } = setup();
    await client.connect();
    const clip = await client.requestClip(10);
    expect(clip).toEqual({
      session_id: 'sess_1',
      kind: 'snap',
      start_marker: 0,
      end_marker: 10,
      now_marker: 10,
      predicted_ready_at_ms: 1_800_000_000_000,
      playlist_url: 'https://api.reactor.inc/sessions/sess_1/clips/c1.m3u8',
    });
    // A correlated clip response is also a runtime event.
    expect(runtime).toContainEqual({ type: 'clipReady', data: clip });
  });

  it('classifies a disabled recorder', async () => {
    const { client, platform } = setup();
    platform.onControl = () => ({ case: 'clip_failed', value: { reason: 'Recorder disabled for this model' } });
    await client.connect();
    await expect(client.requestRecording()).rejects.toMatchObject({ code: 'RECORDER_DISABLED', recoverable: false });
  });

  it('validates the duration', async () => {
    const { client } = setup();
    await client.connect();
    await expect(client.requestClip(0)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('surfaces moderation as a runtime message', async () => {
    const { client, platform, runtime } = setup();
    await client.connect();
    platform.pushControl({
      case: 'moderation',
      value: { action: 'warn', input_kind: 'text', command: 'set_prompt', categories: ['x'], message: 'careful' },
    });
    await flush();
    expect(runtime).toEqual([
      {
        type: 'moderation',
        data: { action: 'warn', input_kind: 'text', command: 'set_prompt', categories: ['x'], message: 'careful' },
      },
    ]);
  });
});

describe('uploads', () => {
  it('creates a presigned upload, PUTs the bytes, and notifies the runtime', async () => {
    const { client, platform } = setup();
    await client.connect();
    const bytes = new Uint8Array([1, 2, 3]);
    const ref = await client.uploadFile({ body: bytes, size: 3, name: 'a.bin', mimeType: 'application/octet-stream' });
    expect(ref).toEqual({ upload_id: 'up_1', name: 'a.bin', mime_type: 'application/octet-stream', size: 3 });
    const create = platform.requests.find((r) => r.url.endsWith('/uploads'))!;
    expect(JSON.parse(create.body as string)).toEqual({ name: 'a.bin', size: 3, mime_type: 'application/octet-stream' });
    expect(platform.uploaded).toEqual([{ url: 'https://uploads.example.com/put?sig=1', body: bytes }]);
    expect(platform.controlReceived.at(-1)!.payload).toEqual({
      case: 'file_uploaded',
      value: { upload_id: 'up_1', name: 'a.bin', mime_type: 'application/octet-stream', size: 3 },
    });
  });
});

describe('teardown', () => {
  it('disconnect ends the session it created', async () => {
    const { client, platform, statuses, sessionIds } = setup();
    await client.connect();
    await client.disconnect();
    expect(platform.sessionDeleted).toBe(true);
    expect(platform.pc.closed).toBe(true);
    expect(statuses.at(-1)).toBe('disconnected');
    expect(sessionIds).toEqual(['sess_1', undefined]);
    expect(client.sessionId()).toBeUndefined();
  });

  it('a dropped peer reports DISCONNECTED and keeps the session for reconnect()', async () => {
    const { client, platform, errors, statuses } = setup();
    await client.connect();
    platform.pc.setState('failed');
    await flush();
    expect(errors).toEqual([{ code: 'DISCONNECTED', message: 'connection disconnected: peer connection state: failed' }]);
    expect(statuses.at(-1)).toBe('disconnected');
    expect(platform.sessionDeleted).toBe(false);
    expect(client.sessionId()).toBe('sess_1');

    await client.reconnect();
    expect(client.status()).toBe('ready');
    // Same connection id, offer replaced with PUT.
    const offers = platform.requests.filter((r) => r.url.endsWith('/sdp_params') && r.method !== 'GET');
    expect(offers.map((r) => r.method)).toEqual(['POST', 'PUT']);
    expect(platform.requests.filter((r) => r.url.endsWith('/connections'))).toHaveLength(1);
  });

  it('fails in-flight requests when the connection goes away', async () => {
    const { client, platform } = setup();
    platform.onCommand = () => 'silent';
    await client.connect();
    const pending = client.sendCommand('slow', {}, undefined);
    await client.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });

  it('reconnect without a session is an error', async () => {
    const { client } = setup();
    await expect(client.reconnect()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('heartbeat', () => {
  it('pings on the control channel while ready, and stops after disconnect', async () => {
    const platform = new FakePlatform();
    let resolveTick: (() => void) | undefined;
    const ticks: number[] = [];
    const client = new ReactorClient({ modelName: 'm', heartbeatIntervalMs: 1000 }, null, {
      webrtc: platform.webrtc,
      http: platform.http,
      wait: (ms) => {
        if (ms !== 1000) return Promise.resolve();
        ticks.push(ms);
        return new Promise<void>((resolve) => (resolveTick = resolve));
      },
    });
    await client.connect();
    const pings = () => platform.controlReceived.filter((m) => m.payload?.case === 'ping').length;
    expect(pings()).toBe(1);
    resolveTick!();
    await flush();
    expect(pings()).toBe(2);
    await client.disconnect();
    resolveTick!();
    await flush();
    expect(pings()).toBe(2);
    // No Authorization header without a token.
    expect(platform.requests[0]!.headers.Authorization).toBeUndefined();
  });

  it('decodes to real ping notifications', async () => {
    const platform = new FakePlatform();
    const client = new ReactorClient({ modelName: 'm', heartbeatIntervalMs: 5 }, null, {
      webrtc: platform.webrtc,
      http: platform.http,
    });
    await client.connect();
    const raw = platform.pc.channel('control').sent.map((b) => decodeControlClientMessage(b));
    expect(raw.find((m) => m.payload?.case === 'ping')).toEqual({
      request_id: '',
      kind: MessageKind.Notification,
      payload: { case: 'ping' },
    });
    await client.disconnect();
  });
});

describe('local runtime', () => {
  it('uses /start_session and /stop_session without auth', async () => {
    const requests: string[] = [];
    const platform = new FakePlatform();
    const http = async (request: any) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.url.endsWith('/start_session')) {
        return {
          status: 200,
          header: () => undefined,
          text: async () =>
            JSON.stringify({
              session_id: 'sess_1',
              state: 'ACTIVE',
              selected_transport: { protocol: 'webrtc', version: '1.0' },
              capabilities: { protocol_version: '1.0', tracks: platform.tracks },
            }),
        };
      }
      if (request.url.endsWith('/stop_session')) return { status: 200, header: () => undefined, text: async () => '' };
      return platform.http({ ...request, url: request.url.replace('http://localhost:8080', 'https://api.reactor.inc') });
    };
    const client = new ReactorClient({ modelName: 'm', local: true, heartbeatIntervalMs: 0 }, 'jwt', {
      webrtc: platform.webrtc,
      http,
      wait: noWait,
    });
    await client.connect();
    await client.disconnect();
    expect(requests[0]).toBe('POST /start_session');
    expect(requests.at(-1)).toBe('POST /stop_session');
  });
});

vi.setConfig({ testTimeout: 5000 });
