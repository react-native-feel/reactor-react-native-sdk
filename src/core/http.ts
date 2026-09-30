/**
 * The HTTP seam: `reactor-core`'s `HttpClient` + `AuthProvider` traits,
 * implemented over React Native's `fetch`.
 *
 * Injected rather than imported everywhere, so the orchestrator can be driven
 * by a fake coordinator in tests with no network at all.
 */
import type { ReactorError } from '../errors';
import { codes, coreError, networkError, statusError } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  /** A JSON body is passed as a string; an upload as bytes or a Blob. */
  body?: string | Uint8Array | ArrayBuffer | Blob;
}

export interface HttpResponse {
  status: number;
  header(name: string): string | undefined;
  text(): Promise<string>;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export const fetchHttpClient: HttpClient = async (request) => {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      // RN's fetch accepts ArrayBuffer and Blob bodies; a Uint8Array view is
      // handed over as its exact bytes, not the whole backing buffer.
      body: toBody(request.body),
    });
  } catch (cause) {
    throw networkError(cause instanceof Error ? cause.message : String(cause));
  }
  return {
    status: response.status,
    header: (name) => response.headers.get(name) ?? undefined,
    text: () => response.text(),
  };
};

function toBody(body: HttpRequest['body']): BodyInit | undefined {
  if (body === undefined || typeof body === 'string' || body instanceof ArrayBuffer) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return body.byteOffset === 0 && body.byteLength === body.buffer.byteLength
      ? (body.buffer as ArrayBuffer)
      : (body.slice().buffer as ArrayBuffer);
  }
  return body;
}

/** `Retry-After` as delta-seconds or an HTTP date, in milliseconds. */
export function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

/** `check_status`: 2xx passes; 426/501 are version mismatches; everything
 *  else becomes the status-keyed error, with the body for context. */
export async function checkStatus(response: HttpResponse, context: string): Promise<void> {
  const { status } = response;
  if (status >= 200 && status < 300) {
    return;
  }
  if (status === 426) {
    throw coreError(codes.VERSION_MISMATCH, `protocol version mismatch: ${context}: client API version too old (426)`, {
      status,
    });
  }
  if (status === 501) {
    throw coreError(
      codes.VERSION_MISMATCH,
      `protocol version mismatch: ${context}: server does not support client API version (501)`,
      { status },
    );
  }
  let body = '';
  try {
    body = await response.text();
  } catch {
    // The status already says what went wrong; the body is only context.
  }
  throw statusError(status, context, body, parseRetryAfterMs(response.header('retry-after')));
}

export async function readJson<T>(response: HttpResponse, context: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw coreError(
      codes.DECODE_FAILED,
      `failed to decode response: ${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────

/** A token, or a resolver called before every authenticated request.
 *  Returning `""` sends no `Authorization` header. */
export type JwtSource = string | (() => string | Promise<string>);

export class AuthProvider {
  private source: JwtSource | null = null;

  constructor(source?: JwtSource | null) {
    this.set(source);
  }

  set(source: JwtSource | null | undefined): void {
    if (source !== null && source !== undefined && typeof source !== 'string' && typeof source !== 'function') {
      throw coreError(codes.INVALID_STATE, 'invalid state: jwt must be a string, a function returning one, or null');
    }
    this.source = source ?? null;
  }

  get current(): JwtSource | null {
    return this.source;
  }

  /** The token for the next request, or `undefined` for none. A resolver that
   *  throws is a network-class failure, as it is in the wasm binding: the
   *  request never went out. */
  async jwt(): Promise<string | undefined> {
    const source = this.source;
    if (source === null) {
      return undefined;
    }
    if (typeof source === 'string') {
      return source || undefined;
    }
    let token: string;
    try {
      token = await source();
    } catch (cause) {
      throw networkError(`jwt resolver rejected: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (typeof token !== 'string') {
      throw coreError(codes.INVALID_STATE, 'invalid state: jwt resolver must return a string');
    }
    return token || undefined;
  }
}

export type { ReactorError };
