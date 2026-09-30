/**
 * `reactor_wire.v1` — the protobuf protocol on the `data` and `control`
 * channels, encoded and decoded by hand against the vendored `.proto` files in
 * `proto/reactor_wire/v1` (pinned in `proto/WIRE_VERSION`, the same release
 * `reactor-client-sdks`' `reactor-protocol` crate builds against).
 *
 * Field numbers below are the ones in those files; `test/wire.test.ts` checks
 * every message against `protoc --encode` output so a drift is a test failure
 * rather than a session that silently ignores what it was sent.
 */
import { ProtoDecodeError, ProtoReader, ProtoWriter, WireType } from './protobuf';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const MessageKind = {
  Unspecified: 0,
  Request: 1,
  Response: 2,
  Notification: 3,
} as const;
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];

export interface WireError {
  code: string;
  message: string;
}

export interface UploadReference {
  upload_id: string;
  name: string;
  mime_type: string;
  size: number;
}

export interface ClipReady {
  session_id: string;
  kind: string;
  start_marker: number;
  end_marker: number;
  now_marker: number;
  predicted_ready_at_ms: number;
  playlist_url: string;
}

export interface Moderation {
  action: string;
  input_kind: string;
  command: string;
  categories: string[];
  message: string;
}

// ── Control channel ─────────────────────────────────────────────────────────

export type ControlClientPayload =
  | { case: 'ping' }
  | { case: 'request_schema' }
  | { case: 'file_uploaded'; value: UploadReference }
  | { case: 'request_clip'; value: { duration_seconds: number } }
  | { case: 'request_recording' }
  | { case: 'publish_track'; value: { name: string } }
  | { case: 'pause_track'; value: { name: string } }
  | { case: 'resume_track'; value: { name: string } }
  | { case: 'unpublish_track'; value: { name: string } }
  | { case: 'error'; value: WireError };

export interface ControlClientMessage {
  request_id: string;
  kind: MessageKind;
  payload?: ControlClientPayload;
}

export type ControlServerPayload =
  | { case: 'model_schema'; value: { openapi: JsonObject | undefined } }
  | { case: 'clip_ready'; value: ClipReady }
  | { case: 'clip_failed'; value: { reason: string } }
  | { case: 'moderation'; value: Moderation }
  | { case: 'publish_track'; value: { name: string } }
  | { case: 'error'; value: WireError };

export interface ControlServerMessage {
  request_id: string;
  kind: number;
  payload?: ControlServerPayload;
}

// ── Data channel ────────────────────────────────────────────────────────────

export interface Command {
  type: string;
  data: JsonObject | undefined;
  uploads: Record<string, UploadReference>;
}

export type DataClientPayload = { case: 'command'; value: Command } | { case: 'error'; value: WireError };

export interface DataClientMessage {
  request_id: string;
  kind: MessageKind;
  payload?: DataClientPayload;
}

export interface ModelMessage {
  type: string;
  data: JsonObject | undefined;
}

export type DataServerPayload = { case: 'message'; value: ModelMessage } | { case: 'error'; value: WireError };

export interface DataServerMessage {
  request_id: string;
  kind: number;
  payload?: DataServerPayload;
}

// ── google.protobuf.Struct ──────────────────────────────────────────────────
//
// Struct   { map<string, Value> fields = 1; }
// Value    { oneof kind { NullValue null_value = 1; double number_value = 2;
//            string string_value = 3; bool bool_value = 4;
//            Struct struct_value = 5; ListValue list_value = 6; } }
// ListValue{ repeated Value values = 1; }

function writeValue(w: ProtoWriter, value: JsonValue): void {
  if (value === null) {
    w.int(1, 0, true);
  } else if (typeof value === 'number') {
    w.double(2, value, true);
  } else if (typeof value === 'string') {
    w.string(3, value, true);
  } else if (typeof value === 'boolean') {
    w.bool(4, value, true);
  } else if (Array.isArray(value)) {
    w.message(6, (list) => {
      for (const element of value) {
        list.message(1, (inner) => writeValue(inner, element));
      }
    });
  } else {
    w.message(5, (inner) => writeStruct(inner, value));
  }
}

function writeStruct(w: ProtoWriter, object: JsonObject): void {
  for (const [key, value] of Object.entries(object)) {
    w.message(1, (entry) => {
      entry.string(1, key, true);
      entry.message(2, (inner) => writeValue(inner, value));
    });
  }
}

function readValue(bytes: Uint8Array): JsonValue {
  const r = new ProtoReader(bytes);
  // A Value with no kind set is not valid JSON; null is the closest reading,
  // and it is what prost's struct_to_value does as well.
  let value: JsonValue = null;
  for (let h = r.next(); h; h = r.next()) {
    switch (h.field) {
      case 1:
        r.varint();
        value = null;
        break;
      case 2:
        value = r.double();
        break;
      case 3:
        value = r.string();
        break;
      case 4:
        value = r.bool();
        break;
      case 5:
        value = readStruct(r.bytes());
        break;
      case 6: {
        const list: JsonValue[] = [];
        const lr = new ProtoReader(r.bytes());
        for (let lh = lr.next(); lh; lh = lr.next()) {
          if (lh.field === 1 && lh.wireType === WireType.LengthDelimited) {
            list.push(readValue(lr.bytes()));
          } else {
            lr.skip(lh.wireType);
          }
        }
        value = list;
        break;
      }
      default:
        r.skip(h.wireType);
    }
  }
  return value;
}

function readStruct(bytes: Uint8Array): JsonObject {
  const r = new ProtoReader(bytes);
  const out: JsonObject = {};
  for (let h = r.next(); h; h = r.next()) {
    if (h.field !== 1 || h.wireType !== WireType.LengthDelimited) {
      r.skip(h.wireType);
      continue;
    }
    const er = new ProtoReader(r.bytes());
    let key = '';
    let value: JsonValue = null;
    for (let eh = er.next(); eh; eh = er.next()) {
      if (eh.field === 1) {
        key = er.string();
      } else if (eh.field === 2) {
        value = readValue(er.bytes());
      } else {
        er.skip(eh.wireType);
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * JSON-compatible object → something `Struct` can carry.
 *
 * `undefined` members are dropped, the way `JSON.stringify` drops them, rather
 * than sent as null — a command's optional argument left `undefined` means
 * "not given", which is what the model's schema validation expects.
 */
export function toJsonObject(data: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(data)) as JsonObject;
}

export function encodeStruct(object: JsonObject): Uint8Array {
  const w = new ProtoWriter();
  writeStruct(w, object);
  return w.finish();
}

export function decodeStruct(bytes: Uint8Array): JsonObject {
  return readStruct(bytes);
}

// ── shared sub-messages ─────────────────────────────────────────────────────

function writeError(w: ProtoWriter, e: WireError): void {
  w.string(1, e.code).string(2, e.message);
}

function readError(bytes: Uint8Array): WireError {
  const r = new ProtoReader(bytes);
  const e: WireError = { code: '', message: '' };
  for (let h = r.next(); h; h = r.next()) {
    if (h.field === 1) {
      e.code = r.string();
    } else if (h.field === 2) {
      e.message = r.string();
    } else {
      r.skip(h.wireType);
    }
  }
  return e;
}

function writeUpload(w: ProtoWriter, u: UploadReference): void {
  w.string(1, u.upload_id).string(2, u.name).string(3, u.mime_type).int(4, u.size);
}

function readName(bytes: Uint8Array): { name: string } {
  const r = new ProtoReader(bytes);
  let name = '';
  for (let h = r.next(); h; h = r.next()) {
    if (h.field === 1) {
      name = r.string();
    } else {
      r.skip(h.wireType);
    }
  }
  return { name };
}

function readTypeAndData(bytes: Uint8Array): ModelMessage {
  const r = new ProtoReader(bytes);
  const m: ModelMessage = { type: '', data: undefined };
  for (let h = r.next(); h; h = r.next()) {
    if (h.field === 1) {
      m.type = r.string();
    } else if (h.field === 2) {
      m.data = readStruct(r.bytes());
    } else {
      r.skip(h.wireType);
    }
  }
  return m;
}

/** Reads the `request_id`/`kind` header shared by every channel message,
 *  handing every other field to `payload`. */
function readEnvelope(
  bytes: Uint8Array,
  payload: (field: number, r: ProtoReader, wireType: number) => boolean,
): { request_id: string; kind: number } {
  const r = new ProtoReader(bytes);
  const envelope = { request_id: '', kind: 0 };
  for (let h = r.next(); h; h = r.next()) {
    if (h.field === 1) {
      envelope.request_id = r.string();
    } else if (h.field === 2) {
      envelope.kind = r.signedVarint();
    } else if (!payload(h.field, r, h.wireType)) {
      r.skip(h.wireType);
    }
  }
  return envelope;
}

// ── Control encode/decode ───────────────────────────────────────────────────

const CONTROL_CLIENT_FIELDS: Record<ControlClientPayload['case'], number> = {
  ping: 10,
  request_schema: 11,
  file_uploaded: 12,
  request_clip: 13,
  request_recording: 14,
  publish_track: 15,
  pause_track: 16,
  resume_track: 17,
  unpublish_track: 18,
  error: 40,
};

export function encodeControlClientMessage(message: ControlClientMessage): Uint8Array {
  const w = new ProtoWriter().string(1, message.request_id).int(2, message.kind);
  const p = message.payload;
  if (p) {
    const field = CONTROL_CLIENT_FIELDS[p.case];
    switch (p.case) {
      case 'ping':
      case 'request_schema':
      case 'request_recording':
        w.message(field, () => {});
        break;
      case 'file_uploaded':
        w.message(field, (m) => writeUpload(m, p.value));
        break;
      case 'request_clip':
        w.message(field, (m) => m.double(1, p.value.duration_seconds));
        break;
      case 'publish_track':
      case 'pause_track':
      case 'resume_track':
      case 'unpublish_track':
        w.message(field, (m) => m.string(1, p.value.name));
        break;
      case 'error':
        w.message(field, (m) => writeError(m, p.value));
        break;
    }
  }
  return w.finish();
}

function readClipReady(bytes: Uint8Array): ClipReady {
  const r = new ProtoReader(bytes);
  const c: ClipReady = {
    session_id: '',
    kind: '',
    start_marker: 0,
    end_marker: 0,
    now_marker: 0,
    predicted_ready_at_ms: 0,
    playlist_url: '',
  };
  for (let h = r.next(); h; h = r.next()) {
    switch (h.field) {
      case 1:
        c.session_id = r.string();
        break;
      case 2:
        c.kind = r.string();
        break;
      case 3:
        c.start_marker = r.double();
        break;
      case 4:
        c.end_marker = r.double();
        break;
      case 5:
        c.now_marker = r.double();
        break;
      case 6:
        c.predicted_ready_at_ms = r.signedVarint();
        break;
      case 7:
        c.playlist_url = r.string();
        break;
      default:
        r.skip(h.wireType);
    }
  }
  return c;
}

function readModeration(bytes: Uint8Array): Moderation {
  const r = new ProtoReader(bytes);
  const m: Moderation = { action: '', input_kind: '', command: '', categories: [], message: '' };
  for (let h = r.next(); h; h = r.next()) {
    switch (h.field) {
      case 1:
        m.action = r.string();
        break;
      case 2:
        m.input_kind = r.string();
        break;
      case 3:
        m.command = r.string();
        break;
      case 4:
        m.categories.push(r.string());
        break;
      case 5:
        m.message = r.string();
        break;
      default:
        r.skip(h.wireType);
    }
  }
  return m;
}

export function decodeControlServerMessage(bytes: Uint8Array): ControlServerMessage {
  let payload: ControlServerPayload | undefined;
  const envelope = readEnvelope(bytes, (field, r, wireType) => {
    if (wireType !== WireType.LengthDelimited) {
      return false;
    }
    switch (field) {
      case 10: {
        const sr = new ProtoReader(r.bytes());
        let openapi: JsonObject | undefined;
        for (let h = sr.next(); h; h = sr.next()) {
          if (h.field === 1) {
            openapi = readStruct(sr.bytes());
          } else {
            sr.skip(h.wireType);
          }
        }
        payload = { case: 'model_schema', value: { openapi } };
        return true;
      }
      case 11:
        payload = { case: 'clip_ready', value: readClipReady(r.bytes()) };
        return true;
      case 12: {
        const fr = new ProtoReader(r.bytes());
        let reason = '';
        for (let h = fr.next(); h; h = fr.next()) {
          if (h.field === 1) {
            reason = fr.string();
          } else {
            fr.skip(h.wireType);
          }
        }
        payload = { case: 'clip_failed', value: { reason } };
        return true;
      }
      case 13:
        payload = { case: 'moderation', value: readModeration(r.bytes()) };
        return true;
      case 14:
        payload = { case: 'publish_track', value: readName(r.bytes()) };
        return true;
      case 40:
        payload = { case: 'error', value: readError(r.bytes()) };
        return true;
      default:
        return false;
    }
  });
  return payload ? { ...envelope, payload } : envelope;
}

// ── Data encode/decode ──────────────────────────────────────────────────────

export function encodeDataClientMessage(message: DataClientMessage): Uint8Array {
  const w = new ProtoWriter().string(1, message.request_id).int(2, message.kind);
  const p = message.payload;
  if (p?.case === 'command') {
    const command = p.value;
    w.message(10, (m) => {
      m.string(1, command.type);
      if (command.data !== undefined) {
        m.message(2, (s) => writeStruct(s, command.data!));
      }
      for (const [param, upload] of Object.entries(command.uploads)) {
        m.message(3, (entry) => {
          entry.string(1, param, true);
          entry.message(2, (u) => writeUpload(u, upload));
        });
      }
    });
  } else if (p?.case === 'error') {
    w.message(40, (m) => writeError(m, p.value));
  }
  return w.finish();
}

export function decodeDataServerMessage(bytes: Uint8Array): DataServerMessage {
  let payload: DataServerPayload | undefined;
  const envelope = readEnvelope(bytes, (field, r, wireType) => {
    if (wireType !== WireType.LengthDelimited) {
      return false;
    }
    if (field === 10) {
      payload = { case: 'message', value: readTypeAndData(r.bytes()) };
      return true;
    }
    if (field === 40) {
      payload = { case: 'error', value: readError(r.bytes()) };
      return true;
    }
    return false;
  });
  return payload ? { ...envelope, payload } : envelope;
}

// ── Server-side encoders, for tests and fakes ───────────────────────────────
//
// A client never sends these; they exist so a fake runtime in the test suite
// can speak the same bytes a real one does, checked against protoc.

export function encodeControlServerMessage(message: ControlServerMessage): Uint8Array {
  const w = new ProtoWriter().string(1, message.request_id).int(2, message.kind);
  const p = message.payload;
  switch (p?.case) {
    case 'model_schema':
      w.message(10, (m) => {
        if (p.value.openapi) {
          m.message(1, (s) => writeStruct(s, p.value.openapi!));
        }
      });
      break;
    case 'clip_ready': {
      const c = p.value;
      w.message(11, (m) =>
        m
          .string(1, c.session_id)
          .string(2, c.kind)
          .double(3, c.start_marker)
          .double(4, c.end_marker)
          .double(5, c.now_marker)
          .int(6, c.predicted_ready_at_ms)
          .string(7, c.playlist_url),
      );
      break;
    }
    case 'clip_failed':
      w.message(12, (m) => m.string(1, p.value.reason));
      break;
    case 'moderation': {
      const mod = p.value;
      w.message(13, (m) => {
        m.string(1, mod.action).string(2, mod.input_kind).string(3, mod.command);
        for (const category of mod.categories) {
          m.string(4, category, true);
        }
        m.string(5, mod.message);
      });
      break;
    }
    case 'publish_track':
      w.message(14, (m) => m.string(1, p.value.name));
      break;
    case 'error':
      w.message(40, (m) => writeError(m, p.value));
      break;
    default:
      break;
  }
  return w.finish();
}

export function encodeDataServerMessage(message: DataServerMessage): Uint8Array {
  const w = new ProtoWriter().string(1, message.request_id).int(2, message.kind);
  const p = message.payload;
  if (p?.case === 'message') {
    w.message(10, (m) => {
      m.string(1, p.value.type);
      if (p.value.data !== undefined) {
        m.message(2, (s) => writeStruct(s, p.value.data!));
      }
    });
  } else if (p?.case === 'error') {
    w.message(40, (m) => writeError(m, p.value));
  }
  return w.finish();
}

export function decodeControlClientMessage(bytes: Uint8Array): ControlClientMessage {
  let payload: ControlClientPayload | undefined;
  const byField = new Map<number, ControlClientPayload['case']>(
    Object.entries(CONTROL_CLIENT_FIELDS).map(([name, field]) => [field, name as ControlClientPayload['case']]),
  );
  const envelope = readEnvelope(bytes, (field, r, wireType) => {
    const name = byField.get(field);
    if (!name || wireType !== WireType.LengthDelimited) {
      return false;
    }
    const inner = r.bytes();
    switch (name) {
      case 'ping':
      case 'request_schema':
      case 'request_recording':
        payload = { case: name };
        break;
      case 'publish_track':
      case 'pause_track':
      case 'resume_track':
      case 'unpublish_track':
        payload = { case: name, value: readName(inner) };
        break;
      case 'request_clip': {
        const cr = new ProtoReader(inner);
        let duration_seconds = 0;
        for (let h = cr.next(); h; h = cr.next()) {
          if (h.field === 1) {
            duration_seconds = cr.double();
          } else {
            cr.skip(h.wireType);
          }
        }
        payload = { case: 'request_clip', value: { duration_seconds } };
        break;
      }
      case 'file_uploaded': {
        const ur = new ProtoReader(inner);
        const u: UploadReference = { upload_id: '', name: '', mime_type: '', size: 0 };
        for (let h = ur.next(); h; h = ur.next()) {
          if (h.field === 1) u.upload_id = ur.string();
          else if (h.field === 2) u.name = ur.string();
          else if (h.field === 3) u.mime_type = ur.string();
          else if (h.field === 4) u.size = ur.signedVarint();
          else ur.skip(h.wireType);
        }
        payload = { case: 'file_uploaded', value: u };
        break;
      }
      case 'error':
        payload = { case: 'error', value: readError(inner) };
        break;
    }
    return true;
  });
  return { request_id: envelope.request_id, kind: envelope.kind as MessageKind, ...(payload ? { payload } : {}) };
}

export function decodeDataClientMessage(bytes: Uint8Array): DataClientMessage {
  let payload: DataClientPayload | undefined;
  const envelope = readEnvelope(bytes, (field, r, wireType) => {
    if (wireType !== WireType.LengthDelimited) {
      return false;
    }
    if (field === 10) {
      const cr = new ProtoReader(r.bytes());
      const command: Command = { type: '', data: undefined, uploads: {} };
      for (let h = cr.next(); h; h = cr.next()) {
        if (h.field === 1) {
          command.type = cr.string();
        } else if (h.field === 2) {
          command.data = readStruct(cr.bytes());
        } else if (h.field === 3) {
          const er = new ProtoReader(cr.bytes());
          let key = '';
          const u: UploadReference = { upload_id: '', name: '', mime_type: '', size: 0 };
          for (let eh = er.next(); eh; eh = er.next()) {
            if (eh.field === 1) {
              key = er.string();
            } else if (eh.field === 2) {
              const ur = new ProtoReader(er.bytes());
              for (let uh = ur.next(); uh; uh = ur.next()) {
                if (uh.field === 1) u.upload_id = ur.string();
                else if (uh.field === 2) u.name = ur.string();
                else if (uh.field === 3) u.mime_type = ur.string();
                else if (uh.field === 4) u.size = ur.signedVarint();
                else ur.skip(uh.wireType);
              }
            } else {
              er.skip(eh.wireType);
            }
          }
          command.uploads[key] = u;
        } else {
          cr.skip(h.wireType);
        }
      }
      payload = { case: 'command', value: command };
      return true;
    }
    if (field === 40) {
      payload = { case: 'error', value: readError(r.bytes()) };
      return true;
    }
    return false;
  });
  return { request_id: envelope.request_id, kind: envelope.kind as MessageKind, ...(payload ? { payload } : {}) };
}

export { ProtoDecodeError };
