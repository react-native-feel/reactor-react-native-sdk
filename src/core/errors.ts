/**
 * `reactor-core`'s `CoreError`, as TypeScript.
 *
 * The Rust core classifies every failure into a canonical code
 * (`crates/reactor-core/src/error.rs`) and the JS SDK turns that code into a
 * typed `ReactorError` subclass. With no wasm in between, this module does
 * both steps at once: every helper returns the public, typed error the JS SDK
 * would have produced for the same failure, with the same code, the same
 * `recoverable` flag and the same message wording.
 */
import { errorForCode, type ReactorError } from '../errors';

export const codes = {
  INVALID_STATE: 'INVALID_STATE',
  DISCONNECTED: 'DISCONNECTED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  BAD_REQUEST: 'BAD_REQUEST',
  SERVER_ERROR: 'SERVER_ERROR',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  DECODE_FAILED: 'DECODE_FAILED',
  SESSION_TERMINAL: 'SESSION_TERMINAL',
  MESSAGE_TOO_LARGE: 'MESSAGE_TOO_LARGE',
  ABORTED: 'ABORTED',
  RECORDER_DISABLED: 'RECORDER_DISABLED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

const RECOVERABLE = new Set<string>([
  codes.DISCONNECTED,
  codes.NETWORK_ERROR,
  codes.REQUEST_TIMEOUT,
  codes.TRANSPORT_ERROR,
  codes.RATE_LIMITED,
  codes.SERVER_ERROR,
]);

export function codeIsRecoverable(code: string): boolean {
  return RECOVERABLE.has(code);
}

export interface CoreErrorFields {
  status?: number | undefined;
  retry_after_ms?: number | undefined;
  operation?: string | undefined;
}

/** Build the typed public error for `code`. */
export function coreError(code: string, message: string, fields: CoreErrorFields = {}): ReactorError {
  const ErrorClass = errorForCode(code);
  return new ErrorClass(message, {
    code,
    recoverable: codeIsRecoverable(code),
    status: fields.status,
    operation: fields.operation,
    retry_after_ms: fields.retry_after_ms,
  });
}

/** Stamp the operation that failed onto an error that did not know it. The
 *  core reports errors with the public method name (`connect`,
 *  `publishTrack`, …); helpers deep inside it do not know which that was. */
export function withOperation(error: ReactorError, operation: string): ReactorError {
  if (error.operation !== undefined) {
    return error;
  }
  const ErrorClass = errorForCode(error.code);
  return new ErrorClass(error.message, {
    code: error.code,
    recoverable: error.recoverable,
    status: error.status,
    operation,
    retry_after_ms: error.retry_after_ms,
    timestamp_ms: error.timestamp_ms,
  });
}

export const invalidState = (message: string) => coreError(codes.INVALID_STATE, `invalid state: ${message}`);
export const timedOut = (what: string) => coreError(codes.REQUEST_TIMEOUT, `timed out: ${what}`);
export const decodeFailed = (message: string) =>
  coreError(codes.DECODE_FAILED, `failed to decode response: ${message}`);
export const peerError = (message: string) => coreError(codes.TRANSPORT_ERROR, `peer transport error: ${message}`);
export const disconnected = (message: string) =>
  coreError(codes.DISCONNECTED, `connection disconnected: ${message}`);
export const aborted = () => coreError(codes.ABORTED, 'operation aborted');
export const networkError = (message: string) => coreError(codes.NETWORK_ERROR, `http transport error: ${message}`);
export const terminalSession = (state: string) =>
  coreError(codes.SESSION_TERMINAL, `session entered terminal state ${state}`);

/** The code an HTTP status maps to — `CoreError::Status`'s own table. */
export function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return codes.UNAUTHORIZED;
  if (status === 404) return codes.NOT_FOUND;
  if (status === 409) return codes.CONFLICT;
  if (status === 426 || status === 501) return codes.VERSION_MISMATCH;
  if (status === 429) return codes.RATE_LIMITED;
  if (status >= 400 && status <= 499) return codes.BAD_REQUEST;
  return codes.SERVER_ERROR;
}

export function statusError(
  status: number,
  context: string,
  body: string,
  retryAfterMs: number | undefined,
): ReactorError {
  return coreError(codeForStatus(status), `unexpected HTTP status ${status} from ${context}: ${body}`, {
    status,
    retry_after_ms: retryAfterMs,
  });
}

/** A failed correlated request: an empty code from the runtime becomes
 *  INTERNAL_ERROR, as in `CoreError::code()`. */
export function requestFailed(kind: 'control' | 'command', name: string, code: string, message: string) {
  const effective = code || codes.INTERNAL_ERROR;
  const text =
    kind === 'control'
      ? `control request '${name}' failed (${code}): ${message}`
      : `command '${name}' failed (${code}): ${message}`;
  return coreError(effective, text);
}

export function recordingError(code: string, message: string): ReactorError {
  return coreError(code || codes.INTERNAL_ERROR, `recording error (${code}): ${message}`);
}

/**
 * `clip_failed_code`: the runtime's `ClipFailed` carries only free text, so
 * the recorder being off is recognized by its wording — a stopgap the Rust
 * core takes as well, until the message grows a structured reason (REA-5403).
 */
export function clipFailedCode(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes('recorder disabled') || lower.includes('encoder crashed')) {
    return codes.RECORDER_DISABLED;
  }
  return codes.INTERNAL_ERROR;
}
