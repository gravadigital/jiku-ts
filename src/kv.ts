import {
  headers,
  InvalidArgumentError,
  NoRespondersError,
  PermissionViolationError,
  RequestError,
  TimeoutError,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
} from '@nats-io/nats-core';

import type { RequestOptions } from './client.ts';
import {
  JikuBucketFull,
  JikuError,
  JikuInvalidRequest,
  JikuKVPermissionDenied,
  JikuNoBucket,
  JikuNotConnected,
  JikuValueTooLarge,
} from './errors.ts';
import { race } from './race.ts';

/**
 * The NATS key-value bucket that holds every identity's space. Jiku's deployment creates and
 * configures it; this client never does. {@link requiredKVPermissions} prints what the deployment
 * has to grant, and `docs/kv.md` covers the bucket settings.
 *
 * There is one bucket for every identity and every instance, not one per identity. The identity
 * is a segment of the key instead, just as it is a segment of every request subject, so the
 * auth-callout can scope it with the same `{{user_id}}` template it already uses.
 */
export const KV_BUCKET = 'JIKU_KV';

/** The JetStream stream behind the bucket. NATS derives the name, not this client. */
const KV_STREAM = `KV_${KV_BUCKET}`;

/** Where binding asks about the bucket. */
const KV_INFO_SUBJECT = `$JS.API.STREAM.INFO.${KV_STREAM}`;

// The error codes nats-server answers with, under its own constant names.
const JS_ERR_NOT_ENABLED_FOR_ACCOUNT = 10039; // JSNotEnabledForAccountErr
const JS_ERR_MESSAGE_EXCEEDS_MAXIMUM = 10054; // JSStreamMessageExceedsMaximumErr
const JS_ERR_STREAM_NOT_FOUND = 10059; // JSStreamNotFoundErr
const JS_ERR_NOT_ENABLED = 10076; // JSNotEnabledErr
const JS_ERR_STORE_FAILED = 10077; // JSStreamStoreFailedF

const EMPTY = new Uint8Array(0);

/**
 * Builds the full key a caller's entry is stored under:
 *
 * ```text
 * {instance}.{userId}.{key}
 * dev.275649063808925701.preferences.theme
 * ```
 *
 * It is the key-value counterpart of `subject()`. The identity is the second segment, and it is
 * the only thing that keeps one identity's entries apart from another's. The auth-callout grants
 * each identity its own prefix and nothing wider, so the bus refuses a key under somebody else's
 * id; this function does not.
 *
 * Unlike a request subject there is NO version segment. A request subject versions a protocol;
 * this is storage, and the format of a stored value is the caller's own.
 */
export function kvKey(instance: string, userId: string, key: string): string {
  return `${instance}.${userId}.${key}`;
}

/**
 * Throws {@link JikuInvalidRequest} for a key NATS would refuse, so the reason is given here
 * instead of as a bare "invalid key". Every operation calls it; it is exported so a caller can
 * check a key before connecting.
 *
 * The rules are NATS's, not this client's: letters, digits and `- / _ = .`, with no empty
 * segment. Wildcards are not among them, which keeps `get` and `delete` exact. Nothing NATS
 * accepts is refused here.
 */
export function assertValidKVKey(key: string): void {
  if (key === '') {
    throw new JikuInvalidRequest('jiku: kv: a key cannot be empty');
  }
  if (key.startsWith('.') || key.endsWith('.') || key.includes('..')) {
    throw new JikuInvalidRequest(
      `jiku: kv: the key ${JSON.stringify(key)} has an empty segment; segments are separated by ` +
        'single dots, with none leading or trailing',
    );
  }
  const bad = NOT_A_KEY_CHARACTER.exec(key)?.[0];
  if (bad !== undefined) {
    throw new JikuInvalidRequest(
      `jiku: kv: the key ${JSON.stringify(key)} contains ${JSON.stringify(bad)}; NATS allows ` +
        'only letters, digits and - / _ = . in a key',
    );
  }
}

/** The first character NATS does not allow in a key. `u` so a character outside the BMP is reported whole. */
const NOT_A_KEY_CHARACTER = /[^A-Za-z0-9\-/_=.]/u;

/** One segment of a key: the allowed characters, without the dot that separates segments. */
const KEY_SEGMENT = /^[A-Za-z0-9\-/_=]+$/;

/**
 * @internal Where a `put` or a `delete` is published. They share it, since a delete is a write
 * with a header, so no permission can allow one without the other.
 */
export function kvWriteSubject(full: string): string {
  return `$KV.${KV_BUCKET}.${full}`;
}

/**
 * @internal Where a `get` is sent. The key is IN the subject, which is what lets a permission
 * confine reads to one identity's prefix; the server refuses a body naming a different key on
 * this form.
 *
 * The bare `$JS.API.DIRECT.GET.KV_JIKU_KV` and `$JS.API.STREAM.MSG.GET.KV_JIKU_KV` take the key in
 * the BODY, which no permission can confine. They are never granted, and this client never falls
 * back to them.
 */
export function kvReadSubject(full: string): string {
  return `$JS.API.DIRECT.GET.${KV_STREAM}.${kvWriteSubject(full)}`;
}

/**
 * Returns the permissions an identity needs to use its key-value space, written as the template
 * lines that grant them.
 *
 * Every line is scoped to the identity's own prefix. A wider grant is a working space too, and
 * that is the danger: nothing fails, and every identity can read and overwrite every other's
 * entries.
 */
export function requiredKVPermissions(instance: string): string {
  return `the key-value space needs these permissions on every role template that should have
it, each confined to the identity's own keys:

  pub:
    allow:
      - "${KV_INFO_SUBJECT}"
      - "$KV.${KV_BUCKET}.${instance}.{{user_id}}.>"
      - "$JS.API.DIRECT.GET.${KV_STREAM}.$KV.${KV_BUCKET}.${instance}.{{user_id}}.>"
  sub:
    allow:
      - "_INBOX.<hash of the user id>.>"     (every template already grants this)

{{user_id}} is the callout's placeholder for the token's sub, raw. It is the same one the
request subjects use, and it is what makes the space per identity.

The second line covers both put and delete. A delete is a write to the same subject with a
header, so no permission can allow one without the other.

Do NOT grant any of these instead. Each one reaches every identity's keys:
  - "$KV.${KV_BUCKET}.>"                       writes and deletes anybody's entries
  - "$JS.API.DIRECT.GET.${KV_STREAM}"          takes the key in the request body, so no subject
                                        permission can confine it
  - "$JS.API.STREAM.MSG.GET.${KV_STREAM}"      the same, through the admin api
  - "$JS.API.>"                         the whole JetStream admin api, deleting the bucket included`;
}

/** One stored value. */
export interface KVEntry {
  /** The key as the caller wrote it, WITHOUT the `{instance}.{userId}.` prefix. */
  key: string;
  value: Uint8Array;
  /**
   * The entry's sequence in the bucket. Every write to ANY key in the bucket moves it, so it
   * orders writes but does not count this key's.
   */
  revision: number;
  /** When the server stored this revision. */
  created: Date;
}

/** @internal What a key-value space needs from the client that opened it. `Client` is one. */
export interface KVHost {
  readonly connection: NatsConnection;
  readonly instance: string;
  readonly userId: string;
  readonly timeoutMs: number;
  readonly closed: boolean;
}

/** A JetStream API error, as it arrives inside a reply. */
interface ApiError {
  code?: number;
  err_code?: number;
  description?: string;
}

/**
 * The caller's own space in the key-value bucket. Keys are passed and returned WITHOUT the
 * `{instance}.{userId}.` prefix, which the space adds itself, so a caller never writes an identity
 * by hand and cannot write one that disagrees with its credential.
 *
 * It offers `put`, `get` and `delete` and nothing else: no keys, no watch, no history. Listing or
 * watching needs a consumer on the bucket, which is a wider grant than three exact subjects.
 *
 * Get one from `client.kv()`. Core takes no part in any of this: the client talks to JetStream
 * directly, and core never sees a key.
 */
export class KV {
  readonly #host: KVHost;
  /** `{instance}.{userId}.` */
  readonly #prefix: string;

  private constructor(host: KVHost) {
    for (const [name, segment] of [
      ['instance', host.instance],
      ['user id', host.userId],
    ] as const) {
      if (!KEY_SEGMENT.test(segment)) {
        throw new JikuInvalidRequest(
          `jiku: kv: the ${name} ${JSON.stringify(segment)} cannot be a segment of a key. It ` +
            'is configuration, not a key: every key is stored under {instance}.{userId}.',
        );
      }
    }
    this.#host = host;
    this.#prefix = kvKey(host.instance, host.userId, '');
  }

  /**
   * @internal Use `client.kv()`, which binds once per client and caches the result.
   *
   * Binding asks JetStream about the bucket, and refuses one without `allow_direct`.
   */
  static async bind(host: KVHost, options: RequestOptions = {}): Promise<KV> {
    const space = new KV(host);
    const reply = await space.#request('binding the bucket', '', KV_INFO_SUBJECT, EMPTY, options);
    const info = space.#decode('binding the bucket', reply) as {
      error?: ApiError;
      config?: { allow_direct?: boolean };
    };
    if (info.error) {
      throw space.#apiError('binding the bucket', '', KV_INFO_SUBJECT, info.error);
    }
    checkKVStream(info.config);
    return space;
  }

  /** Stores `value` under `key`, replacing what was there, and returns the new revision. */
  async put(
    key: string,
    value: Uint8Array | string,
    options: RequestOptions = {},
  ): Promise<number> {
    const subject = kvWriteSubject(this.#full(key));
    const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return this.#publish('put', key, subject, data, options);
  }

  /**
   * Returns the value stored under `key`, or `undefined` when there is none: it was never
   * written, it was deleted, or the bucket's TTL expired it. For a cache that is a miss, not a
   * failure.
   */
  async get(key: string, options: RequestOptions = {}): Promise<KVEntry | undefined> {
    const subject = kvReadSubject(this.#full(key));
    const message = await this.#request('get', key, subject, EMPTY, options);
    const h = message.headers;
    if (h?.code === 404) {
      return undefined;
    }
    if (!h || h.hasError) {
      throw new JikuError(
        `jiku: kv: get ${JSON.stringify(key)}: JetStream answered ` +
          (h ? `${String(h.code)} ${h.description}` : 'without the headers a direct get carries'),
      );
    }
    // A delete leaves a marker in place of the value, and a direct get returns the marker.
    const operation = h.get('KV-Operation');
    if (operation === 'DEL' || operation === 'PURGE') {
      return undefined;
    }
    return {
      key,
      // A copy: the message's bytes are the connection's, not the caller's.
      value: new Uint8Array(message.data),
      revision: Number(h.get('Nats-Sequence')),
      created: parseTimestamp(h.get('Nats-Time-Stamp')),
    };
  }

  /**
   * Removes the value under `key`. Deleting a key that holds nothing succeeds.
   *
   * The bucket keeps a small marker in place of the value; with the bucket's history at 1 the
   * marker replaces the value rather than sitting beside it.
   */
  async delete(key: string, options: RequestOptions = {}): Promise<void> {
    const subject = kvWriteSubject(this.#full(key));
    const marker = headers();
    marker.set('KV-Operation', 'DEL');
    await this.#publish('delete', key, subject, EMPTY, options, marker);
  }

  #full(key: string): string {
    assertValidKVKey(key);
    return this.#prefix + key;
  }

  /** Publishes a write and returns the sequence JetStream stored it at. */
  async #publish(
    op: string,
    key: string,
    subject: string,
    data: Uint8Array,
    options: RequestOptions,
    hdrs?: MsgHdrs,
  ): Promise<number> {
    const reply = await this.#request(op, key, subject, data, options, hdrs);
    const ack = this.#decode(op, reply) as { error?: ApiError; seq?: unknown };
    if (ack.error) {
      throw this.#apiError(op, key, subject, ack.error);
    }
    if (typeof ack.seq !== 'number') {
      throw new JikuError(
        `jiku: kv: ${describe(op, key)}: JetStream acknowledged without a sequence: ` +
          new TextDecoder().decode(reply.data),
      );
    }
    return ack.seq;
  }

  /**
   * Sends one request under the client's timeout.
   *
   * A refused publish fails the moment the violation lands, not at the timeout: the NATS client
   * correlates the server's `Permissions Violation` with the request in flight and rejects it,
   * which is the contract's "a refused publish fails at once".
   */
  async #request(
    op: string,
    key: string,
    subject: string,
    data: Uint8Array,
    options: RequestOptions,
    hdrs?: MsgHdrs,
  ): Promise<Msg> {
    const nc = this.#host.connection;
    if (this.#host.closed || nc.isClosed()) {
      throw new JikuNotConnected();
    }
    options.signal?.throwIfAborted();
    const timeoutMs =
      options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : this.#host.timeoutMs;
    try {
      return await race(
        nc.request(subject, data, { timeout: timeoutMs, ...(hdrs ? { headers: hdrs } : {}) }),
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason;
      }
      throw this.#transportError(op, key, subject, timeoutMs, error);
    }
  }

  #decode(op: string, reply: Msg): Record<string, unknown> {
    const text = new TextDecoder().decode(reply.data);
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Reported below, with the bytes.
    }
    throw new JikuError(`jiku: kv: ${op}: JetStream's reply is not a JSON object: ${text}`);
  }

  /** Explains a failure on the transport: a refusal by the bus, nobody answering, or silence. */
  #transportError(
    op: string,
    key: string,
    subject: string,
    timeoutMs: number,
    error: unknown,
  ): Error {
    const what = describe(op, key);
    const cause = error instanceof RequestError ? error.cause : error;

    // A permissions violation wins whenever one arrived: it is the cause, and whatever surfaced
    // is the symptom.
    const violation =
      error instanceof PermissionViolationError
        ? error
        : cause instanceof PermissionViolationError
          ? cause
          : undefined;
    if (violation) {
      const refused = violation.subject || subject;
      return new JikuKVPermissionDenied(
        `jiku: kv: the bus refused ${what} (${refused})\n` +
          '  The bus refused the subject before JetStream saw anything, so this says nothing ' +
          "about\n  the bucket. Your token's role selected a permission template without this " +
          `grant.\n\n${requiredKVPermissions(this.#host.instance)}`,
        refused,
        { cause: error },
      );
    }

    if (
      cause instanceof NoRespondersError ||
      (error instanceof RequestError && error.isNoResponders())
    ) {
      if (subject === KV_INFO_SUBJECT) {
        return new JikuNoBucket(
          `jiku: kv: ${what}: nothing answered ${KV_INFO_SUBJECT}, so JetStream is not ` +
            'enabled for this account, or not running. The key-value space lives in JetStream; ' +
            "that is the deployment's configuration, not this client's.",
          { cause: error },
        );
      }
      return new JikuNoBucket(
        `jiku: kv: nothing answered ${what} on ${JSON.stringify(subject)}, so no stream stores ` +
          'this subject. The bucket was removed after it was bound, or JetStream is down on this ' +
          'deployment.',
        { cause: error },
      );
    }

    if (
      [error, cause].some(
        (e) => e instanceof InvalidArgumentError && e.message.includes('max_payload'),
      )
    ) {
      const limit = this.#host.connection.info?.max_payload;
      return new JikuValueTooLarge(
        `jiku: kv: ${what} is larger than ` +
          (limit
            ? `the server's max_payload of ${String(limit)} bytes`
            : "the server's max_payload") +
          ', so NATS refused it before JetStream saw it. Store less under one key, or split it ' +
          'across several.',
        { cause: error },
      );
    }

    if (error instanceof TimeoutError || cause instanceof TimeoutError) {
      // Not JikuTimeout: that one reads "no reply from core", and core is not involved here.
      return new JikuError(
        `jiku: kv: ${what}: JetStream did not answer within ${String(timeoutMs)}ms. Two causes ` +
          'end in this same silence:\n' +
          "  1. JetStream is slow or down, or the bucket's stream has no leader. Whoever runs " +
          `the\n     deployment can check it with \`nats stream info ${KV_STREAM}\`.\n` +
          `  2. The bus refused ${JSON.stringify(subject)} and the refusal never reached this ` +
          "request. A refused\n     publish is dropped, not answered, so compare your role's " +
          `template with:\n\n${requiredKVPermissions(this.#host.instance)}`,
        { cause: error },
      );
    }

    return new JikuError(`jiku: kv: ${what}`, { cause: error });
  }

  /** Explains an error JetStream itself answered with, inside the reply. */
  #apiError(op: string, key: string, subject: string, error: ApiError): Error {
    const what = describe(op, key);
    const said =
      `\n\nJetStream said: ${error.description ?? '(no description)'} ` +
      `(code ${String(error.code ?? '?')}, err_code ${String(error.err_code ?? '?')})`;

    switch (error.err_code) {
      case JS_ERR_STREAM_NOT_FOUND:
        return new JikuNoBucket(
          `jiku: kv: ${what}: the bucket ${KV_BUCKET} does not exist on this deployment. ` +
            "Jiku's deployment creates it; this client never does." +
            said,
        );
      case JS_ERR_NOT_ENABLED:
      case JS_ERR_NOT_ENABLED_FOR_ACCOUNT:
        return new JikuNoBucket(
          `jiku: kv: ${what}: JetStream is not enabled for this account, and the key-value ` +
            "space lives in JetStream. That is the deployment's configuration, not this client's." +
            said,
        );
      case JS_ERR_MESSAGE_EXCEEDS_MAXIMUM:
        return new JikuValueTooLarge(
          `jiku: kv: ${what} is larger than the bucket's maximum value size, which Jiku's ` +
            'deployment sets. Store less under one key, or split it across several.' +
            said,
        );
      case JS_ERR_STORE_FAILED:
        // Only a LIMIT is a full bucket. Any other store failure reported as one would send the
        // reader deleting entries over a disk error.
        if (/maximum/i.test(error.description ?? '')) {
          return new JikuBucketFull(
            `jiku: kv: ${what} was refused because the bucket reached its limit. The limit is ` +
              "the bucket's, shared by every identity, so this is not necessarily your doing. " +
              "Space comes back as entries expire under the bucket's TTL or are deleted; delete " +
              'what you no longer need.' +
              said,
          );
        }
        break;
    }
    return new JikuError(`jiku: kv: ${what} on ${JSON.stringify(subject)} was refused.${said}`);
  }
}

/**
 * @internal Refuses a bucket this space cannot use safely.
 *
 * Without `allow_direct` a NATS client sends a get to `$JS.API.STREAM.MSG.GET`, whose request
 * carries the key in its BODY: no subject permission can confine it to one identity, and granting
 * it lets every identity read every other's entries. This client never sends that request — but
 * the failure would still show up as a permissions error on that subject in somebody's client,
 * and the obvious fix, granting it, is the wrong one. So the bucket is refused here, where the
 * message can point at the bucket instead.
 */
export function checkKVStream(config: { allow_direct?: boolean } | undefined): void {
  if (!config?.allow_direct) {
    throw new JikuNoBucket(
      `jiku: kv: the bucket ${KV_BUCKET} does not have allow_direct set.\n` +
        `  Without it a get goes to $JS.API.STREAM.MSG.GET.${KV_STREAM}, which takes the key in ` +
        "the request\n  BODY: no permission can confine it to one identity's keys, and granting " +
        "it lets every\n  identity read every other's entries. Do not grant it. Fix the bucket " +
        `instead: Jiku's\n  deployment must create ${KV_BUCKET} with allow_direct, which ` +
        '`nats kv add` sets by default.',
    );
  }
}

function describe(op: string, key: string): string {
  return key ? `${op} ${JSON.stringify(key)}` : op;
}

/** JetStream stamps RFC 3339 with nanoseconds; a `Date` holds milliseconds. */
function parseTimestamp(value: string): Date {
  return new Date(value.replace(/(\.\d{3})\d+/, '$1'));
}
