import { JikuError, JikuFailure, type ErrorDetails } from './errors.ts';

/**
 * An envelope as it arrives: every field is a claim the bytes make, not one the type system
 * can vouch for. {@link decodeReply} narrows this to {@link Reply}, and the checks it makes are
 * the reason a caller can then trust the result.
 */
type RawReply = { [K in keyof Reply]?: unknown };

/** The envelope's `status`. It is the only field that is always present. */
export type Status = 'success' | 'failure';

/**
 * The envelope every endpoint answers with, shared by commands and queries.
 *
 * On a failure the envelope travels in the BODY. The `Nats-Service-Error` headers are added
 * alongside it, never as a replacement — so this object is always the authority, and the micro
 * transport's 500 is not the error's status.
 */
export interface Reply<T = unknown> {
  status: Status;
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: ErrorDetails;
  data?: T;
}

/**
 * Decodes reply bytes into an envelope.
 *
 * A reply that is not an envelope is a bug in something, and the raw bytes are worth more than
 * a parse error on its own — so a truncated copy of them goes into the message.
 */
export function decodeReply<T = unknown>(bytes: Uint8Array, method: string): Reply<T> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new JikuError(`jiku: ${method} answered bytes that are not UTF-8`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new JikuError(
      `jiku: ${method} answered something that is not an envelope: ${
        cause instanceof Error ? cause.message : String(cause)
      }\n  raw: ${truncate(text, 400)}`,
      { cause },
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new JikuError(
      `jiku: ${method} answered a ${describeJson(parsed)} rather than an envelope object\n` +
        `  raw: ${truncate(text, 400)}`,
    );
  }

  const reply = parsed as RawReply;
  if (reply.status !== 'success' && reply.status !== 'failure') {
    throw new JikuError(
      `jiku: ${method} answered an envelope with no usable status (got ` +
        `${JSON.stringify(reply.status)}; every envelope carries "success" or "failure")\n` +
        `  raw: ${truncate(text, 400)}`,
    );
  }
  return reply as Reply<T>;
}

/**
 * Turns a failure envelope into a {@link JikuFailure}, or returns `undefined` for a success.
 *
 * It never throws on its own so {@link Client.request} can hand a caller the raw envelope
 * without deciding for them whether a failure is an error.
 */
export function failureOf(reply: Reply, method: string): JikuFailure | undefined {
  if (reply.status === 'success') {
    return undefined;
  }
  return new JikuFailure({
    code: reply.errorCode ?? '',
    ...(reply.errorMessage === undefined ? {} : { errorMessage: reply.errorMessage }),
    ...(reply.errorDetails === undefined ? {} : { details: reply.errorDetails }),
    method,
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function describeJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'JSON array';
  return `JSON ${typeof value}`;
}
