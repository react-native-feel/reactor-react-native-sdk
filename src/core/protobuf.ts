/**
 * A minimal protobuf (proto3) reader/writer — just the wire types
 * `reactor_wire.v1` uses: varint, 64-bit (double), and length-delimited.
 *
 * Hand-written rather than generated because the whole schema is six small
 * files (see `proto/reactor_wire/v1`), and a code generator's runtime would be
 * the largest thing in this package. It is also written against nothing
 * Hermes might lack: no `TextEncoder`/`TextDecoder` (UTF-8 is done here), and
 * `BigInt` only on the rare path of a varint wider than 2^53.
 */

export const WireType = {
  Varint: 0,
  Fixed64: 1,
  LengthDelimited: 2,
  Fixed32: 5,
} as const;

// ── UTF-8 ───────────────────────────────────────────────────────────────────

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    // Combine a surrogate pair into one code point; a lone surrogate becomes
    // U+FFFD, which is what TextEncoder does too.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++]!;
    let code: number;
    if (b0 < 0x80) {
      code = b0;
    } else if (b0 >= 0xc0 && b0 < 0xe0 && i < bytes.length) {
      code = ((b0 & 0x1f) << 6) | (bytes[i++]! & 0x3f);
    } else if (b0 >= 0xe0 && b0 < 0xf0 && i + 1 < bytes.length) {
      code = ((b0 & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    } else if (b0 >= 0xf0 && b0 < 0xf8 && i + 2 < bytes.length) {
      code =
        ((b0 & 0x07) << 18) |
        ((bytes[i++]! & 0x3f) << 12) |
        ((bytes[i++]! & 0x3f) << 6) |
        (bytes[i++]! & 0x3f);
    } else {
      code = 0xfffd;
    }
    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

// ── Writer ──────────────────────────────────────────────────────────────────

export class ProtoWriter {
  private readonly bytes: number[] = [];

  private tag(field: number, wireType: number): void {
    this.rawVarint(field * 8 + wireType);
  }

  /** Unsigned varint of a non-negative safe integer. */
  private rawVarint(value: number): void {
    let v = value;
    while (v >= 0x80) {
      this.bytes.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.bytes.push(v);
  }

  /** int32/int64/enum. Negative values are 10-byte two's complement, as the
   *  spec requires for both widths. */
  private signedVarint(value: number): void {
    if (value >= 0) {
      this.rawVarint(value);
      return;
    }
    let v = BigInt.asUintN(64, BigInt(Math.trunc(value)));
    while (v >= 0x80n) {
      this.bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.bytes.push(Number(v));
  }

  /** A proto3 scalar is omitted at its default unless it is a oneof member. */
  int(field: number, value: number, always = false): this {
    if (value !== 0 || always) {
      this.tag(field, WireType.Varint);
      this.signedVarint(value);
    }
    return this;
  }

  bool(field: number, value: boolean, always = false): this {
    if (value || always) {
      this.tag(field, WireType.Varint);
      this.bytes.push(value ? 1 : 0);
    }
    return this;
  }

  double(field: number, value: number, always = false): this {
    // `Object.is` so that -0 is written: it is not the default value 0.
    if (!Object.is(value, 0) || always) {
      this.tag(field, WireType.Fixed64);
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, value, true);
      for (let i = 0; i < 8; i++) {
        this.bytes.push(view.getUint8(i));
      }
    }
    return this;
  }

  string(field: number, value: string, always = false): this {
    if (value !== '' || always) {
      this.bytesField(field, utf8Encode(value));
    }
    return this;
  }

  bytesField(field: number, value: Uint8Array): this {
    this.tag(field, WireType.LengthDelimited);
    this.rawVarint(value.length);
    for (let i = 0; i < value.length; i++) {
      this.bytes.push(value[i]!);
    }
    return this;
  }

  /** An embedded message. Always written when called, so an empty message
   *  in a oneof (`Ping {}`) still says which case is set. */
  message(field: number, write: (writer: ProtoWriter) => void): this {
    const inner = new ProtoWriter();
    write(inner);
    return this.bytesField(field, inner.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

// ── Reader ──────────────────────────────────────────────────────────────────

export class ProtoDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtoDecodeError';
  }
}

export class ProtoReader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Next field header, or `undefined` at the end of the buffer. */
  next(): { field: number; wireType: number } | undefined {
    if (this.done) {
      return undefined;
    }
    const key = this.varint();
    const field = Math.floor(key / 8);
    if (field === 0) {
      throw new ProtoDecodeError('field number 0');
    }
    return { field, wireType: key % 8 };
  }

  /** A varint as a JS number. Values past 2^53 lose precision rather than
   *  throw: no field in this schema carries one. */
  varint(): number {
    let result = 0;
    let multiplier = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) {
        throw new ProtoDecodeError('truncated varint');
      }
      const byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * multiplier;
      if (byte < 0x80) {
        return result;
      }
      multiplier *= 0x80;
    }
    throw new ProtoDecodeError('varint longer than 10 bytes');
  }

  /** int32/int64: a varint whose top bit set means negative. */
  signedVarint(): number {
    const start = this.pos;
    const unsigned = this.varint();
    if (unsigned < 2 ** 63) {
      return unsigned;
    }
    // Re-read exactly as a 64-bit two's complement value.
    this.pos = start;
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.buf[this.pos++]!;
      v |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) {
        break;
      }
      shift += 7n;
    }
    return Number(BigInt.asIntN(64, v));
  }

  bool(): boolean {
    return this.varint() !== 0;
  }

  double(): number {
    if (this.pos + 8 > this.buf.length) {
      throw new ProtoDecodeError('truncated double');
    }
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  bytes(): Uint8Array {
    const length = this.varint();
    if (this.pos + length > this.buf.length) {
      throw new ProtoDecodeError('truncated length-delimited field');
    }
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  string(): string {
    return utf8Decode(this.bytes());
  }

  /** Skip a field this decoder does not know — forward compatibility with a
   *  newer runtime is the whole point of a tagged format. */
  skip(wireType: number): void {
    switch (wireType) {
      case WireType.Varint:
        this.varint();
        return;
      case WireType.Fixed64:
        this.pos += 8;
        return;
      case WireType.LengthDelimited:
        this.bytes();
        return;
      case WireType.Fixed32:
        this.pos += 4;
        return;
      default:
        throw new ProtoDecodeError(`unsupported wire type ${wireType}`);
    }
  }
}
