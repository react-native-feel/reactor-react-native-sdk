import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MessageKind,
  decodeControlClientMessage,
  decodeControlServerMessage,
  decodeDataClientMessage,
  decodeDataServerMessage,
  decodeStruct,
  encodeControlClientMessage,
  encodeControlServerMessage,
  encodeDataClientMessage,
  encodeDataServerMessage,
  encodeStruct,
  type ControlClientMessage,
  type ControlServerMessage,
  type DataClientMessage,
  type DataServerMessage,
} from '../src/core/wire';
import { utf8Decode, utf8Encode } from '../src/core/protobuf';

// Golden bytes come from protoc itself, against the vendored .proto files: the
// codec is hand-written, so the only thing that can say it is right is the
// reference implementation reading the same schema.

const ROOT = join(__dirname, '..', 'proto');
const PROTOC = ['/opt/homebrew/bin/protoc', '/usr/local/bin/protoc', '/usr/bin/protoc'].find(existsSync);
const INCLUDES = ['/opt/homebrew/include', '/usr/local/include', '/usr/include'].filter((dir) =>
  existsSync(join(dir, 'google/protobuf/struct.proto')),
);

function protoc(mode: 'encode' | 'decode', type: string, file: string, input: Buffer | string): Buffer {
  const args = [
    `--${mode}=reactor_wire.v1.${type}`,
    `-I${ROOT}`,
    ...INCLUDES.map((dir) => `-I${dir}`),
    `reactor_wire/v1/${file}.proto`,
  ];
  return execFileSync(PROTOC!, args, { input });
}

const withProtoc = PROTOC && INCLUDES.length > 0 ? describe : describe.skip;

withProtoc('reactor_wire.v1 against protoc', () => {
  const controlClient: Array<[string, ControlClientMessage]> = [
    [
      'request_id: "" kind: MESSAGE_KIND_NOTIFICATION ping {}',
      { request_id: '', kind: MessageKind.Notification, payload: { case: 'ping' } },
    ],
    [
      'request_id: "ctrl_1" kind: MESSAGE_KIND_REQUEST request_schema {}',
      { request_id: 'ctrl_1', kind: MessageKind.Request, payload: { case: 'request_schema' } },
    ],
    [
      'request_id: "ctrl_2" kind: MESSAGE_KIND_REQUEST publish_track { name: "webcam" }',
      {
        request_id: 'ctrl_2',
        kind: MessageKind.Request,
        payload: { case: 'publish_track', value: { name: 'webcam' } },
      },
    ],
    [
      'kind: MESSAGE_KIND_NOTIFICATION pause_track { name: "main_video" }',
      {
        request_id: '',
        kind: MessageKind.Notification,
        payload: { case: 'pause_track', value: { name: 'main_video' } },
      },
    ],
    [
      'kind: MESSAGE_KIND_NOTIFICATION resume_track { name: "main_video" }',
      {
        request_id: '',
        kind: MessageKind.Notification,
        payload: { case: 'resume_track', value: { name: 'main_video' } },
      },
    ],
    [
      'kind: MESSAGE_KIND_NOTIFICATION unpublish_track { name: "mic" }',
      {
        request_id: '',
        kind: MessageKind.Notification,
        payload: { case: 'unpublish_track', value: { name: 'mic' } },
      },
    ],
    [
      'request_id: "ctrl_3" kind: MESSAGE_KIND_REQUEST request_clip { duration_seconds: 12.5 }',
      {
        request_id: 'ctrl_3',
        kind: MessageKind.Request,
        payload: { case: 'request_clip', value: { duration_seconds: 12.5 } },
      },
    ],
    [
      'request_id: "ctrl_4" kind: MESSAGE_KIND_REQUEST request_recording {}',
      { request_id: 'ctrl_4', kind: MessageKind.Request, payload: { case: 'request_recording' } },
    ],
    [
      'kind: MESSAGE_KIND_NOTIFICATION file_uploaded { upload_id: "up_1" name: "ñandú.png" mime_type: "image/png" size: 5000000000 }',
      {
        request_id: '',
        kind: MessageKind.Notification,
        payload: {
          case: 'file_uploaded',
          value: { upload_id: 'up_1', name: 'ñandú.png', mime_type: 'image/png', size: 5_000_000_000 },
        },
      },
    ],
  ];

  it.each(controlClient)('ControlClientMessage %s', (text, message) => {
    const golden = protoc('encode', 'ControlClientMessage', 'control', text);
    expect(Buffer.from(encodeControlClientMessage(message))).toEqual(golden);
    expect(decodeControlClientMessage(new Uint8Array(golden))).toEqual(message);
  });

  const controlServer: Array<[string, ControlServerMessage]> = [
    [
      'request_id: "ctrl_2" kind: MESSAGE_KIND_RESPONSE publish_track { name: "webcam" }',
      {
        request_id: 'ctrl_2',
        kind: MessageKind.Response,
        payload: { case: 'publish_track', value: { name: 'webcam' } },
      },
    ],
    [
      'request_id: "ctrl_2" kind: MESSAGE_KIND_RESPONSE error { code: "TRACK_BUSY" message: "slot taken" }',
      {
        request_id: 'ctrl_2',
        kind: MessageKind.Response,
        payload: { case: 'error', value: { code: 'TRACK_BUSY', message: 'slot taken' } },
      },
    ],
    [
      'request_id: "ctrl_3" kind: MESSAGE_KIND_RESPONSE clip_ready { session_id: "s" kind: "snap" start_marker: 1.5 end_marker: 13 now_marker: 14.25 predicted_ready_at_ms: 1790000000123 playlist_url: "/clips/s/x.m3u8" }',
      {
        request_id: 'ctrl_3',
        kind: MessageKind.Response,
        payload: {
          case: 'clip_ready',
          value: {
            session_id: 's',
            kind: 'snap',
            start_marker: 1.5,
            end_marker: 13,
            now_marker: 14.25,
            predicted_ready_at_ms: 1_790_000_000_123,
            playlist_url: '/clips/s/x.m3u8',
          },
        },
      },
    ],
    [
      'request_id: "ctrl_4" kind: MESSAGE_KIND_RESPONSE clip_failed { reason: "recorder disabled" }',
      {
        request_id: 'ctrl_4',
        kind: MessageKind.Response,
        payload: { case: 'clip_failed', value: { reason: 'recorder disabled' } },
      },
    ],
    [
      'kind: MESSAGE_KIND_NOTIFICATION moderation { action: "warn" input_kind: "text" command: "set_prompt" categories: "violence" categories: "gore" message: "careful" }',
      {
        request_id: '',
        kind: MessageKind.Notification,
        payload: {
          case: 'moderation',
          value: {
            action: 'warn',
            input_kind: 'text',
            command: 'set_prompt',
            categories: ['violence', 'gore'],
            message: 'careful',
          },
        },
      },
    ],
  ];

  it.each(controlServer)('ControlServerMessage %s', (text, message) => {
    const golden = protoc('encode', 'ControlServerMessage', 'control', text);
    expect(decodeControlServerMessage(new Uint8Array(golden))).toEqual(message);
    expect(Buffer.from(encodeControlServerMessage(message))).toEqual(golden);
  });

  it('model_schema carries an arbitrary JSON document through Struct', () => {
    const openapi = {
      openapi: '3.1.0',
      info: { title: 'demo', version: '1' },
      paths: { '/set_prompt': { post: { summary: 'Set it', deprecated: false } } },
      'x-reactor': { tracks: [{ name: 'main_video', kind: 'video', direction: 'recvonly' }] },
      nothing: null,
      weight: -0.25,
    };
    const bytes = encodeControlServerMessage({
      request_id: 'ctrl_1',
      kind: MessageKind.Response,
      payload: { case: 'model_schema', value: { openapi } },
    });
    // protoc must accept our bytes as a valid ControlServerMessage…
    const text = protoc('decode', 'ControlServerMessage', 'control', Buffer.from(bytes)).toString();
    expect(text).toContain('model_schema');
    expect(text).toContain('string_value: "main_video"');
    // …and re-encoding its reading must decode to the same document.
    const golden = protoc('encode', 'ControlServerMessage', 'control', text);
    const decoded = decodeControlServerMessage(new Uint8Array(golden));
    expect(decoded.payload).toEqual({ case: 'model_schema', value: { openapi } });
  });

  it('DataClientMessage command with data and uploads', () => {
    const message: DataClientMessage = {
      request_id: 'data_7',
      kind: MessageKind.Request,
      payload: {
        case: 'command',
        value: {
          type: 'set_prompt',
          data: { prompt: 'a forest at dawn 🌲', strength: 0.8, loop: true, tags: ['a', 1, null] },
          uploads: {
            image: { upload_id: 'up_9', name: 'ref.png', mime_type: 'image/png', size: 42 },
          },
        },
      },
    };
    const ours = encodeDataClientMessage(message);
    const text = protoc('decode', 'DataClientMessage', 'data', Buffer.from(ours)).toString();
    expect(text).toContain('type: "set_prompt"');
    expect(text).toContain('upload_id: "up_9"');
    const golden = protoc('encode', 'DataClientMessage', 'data', text);
    expect(decodeDataClientMessage(new Uint8Array(golden))).toEqual(message);
  });

  it('DataClientMessage command with an empty object still sends data', () => {
    const message: DataClientMessage = {
      request_id: 'data_1',
      kind: MessageKind.Request,
      payload: { case: 'command', value: { type: 'start', data: {}, uploads: {} } },
    };
    const golden = protoc(
      'encode',
      'DataClientMessage',
      'data',
      'request_id: "data_1" kind: MESSAGE_KIND_REQUEST command { type: "start" data {} }',
    );
    expect(Buffer.from(encodeDataClientMessage(message))).toEqual(golden);
  });

  it('DataServerMessage: a model message, a bodyless ack, and an error', () => {
    const cases: Array<[string, DataServerMessage]> = [
      [
        'kind: MESSAGE_KIND_NOTIFICATION message { type: "state" data { fields { key: "frame" value { number_value: 42 } } } }',
        {
          request_id: '',
          kind: MessageKind.Notification,
          payload: { case: 'message', value: { type: 'state', data: { frame: 42 } } },
        },
      ],
      ['request_id: "data_3" kind: MESSAGE_KIND_RESPONSE', { request_id: 'data_3', kind: MessageKind.Response }],
      [
        'request_id: "data_4" kind: MESSAGE_KIND_RESPONSE error { code: "INVALID_ARGS" message: "prompt required" }',
        {
          request_id: 'data_4',
          kind: MessageKind.Response,
          payload: { case: 'error', value: { code: 'INVALID_ARGS', message: 'prompt required' } },
        },
      ],
    ];
    for (const [text, message] of cases) {
      const golden = protoc('encode', 'DataServerMessage', 'data', text);
      expect(decodeDataServerMessage(new Uint8Array(golden))).toEqual(message);
      expect(Buffer.from(encodeDataServerMessage(message))).toEqual(golden);
    }
  });

  it('skips fields it does not know', () => {
    // Field 99 is not in the schema: a newer runtime adding it must not break
    // an older client.
    const known = protoc(
      'encode',
      'ControlServerMessage',
      'control',
      'request_id: "x" kind: MESSAGE_KIND_RESPONSE clip_failed { reason: "r" }',
    );
    const unknown = Buffer.from([0x98, 0x06, 0x07, 0xa2, 0x06, 0x02, 0x68, 0x69]); // 99:varint 7, 100:"hi"
    const decoded = decodeControlServerMessage(new Uint8Array(Buffer.concat([unknown, known])));
    expect(decoded.payload).toEqual({ case: 'clip_failed', value: { reason: 'r' } });
  });
});

describe('Struct and UTF-8 without protoc', () => {
  it('round-trips nested JSON', () => {
    const value = { a: [1, 'two', { three: false }], b: { c: null }, d: '' };
    expect(decodeStruct(encodeStruct(value))).toEqual(value);
  });

  it('UTF-8 matches the platform encoder, astral planes included', () => {
    const samples = ['', 'ascii', 'ñandú', '日本語', '🌲🦕', 'mixed ✓ 😀 z'];
    for (const s of samples) {
      expect(Buffer.from(utf8Encode(s))).toEqual(Buffer.from(s, 'utf8'));
      expect(utf8Decode(new Uint8Array(Buffer.from(s, 'utf8')))).toBe(s);
    }
  });
});
