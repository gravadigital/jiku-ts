import {
  NoRespondersError,
  PermissionViolationError,
  RequestError,
  TimeoutError,
  type Msg,
  type NatsConnection,
  type Status,
} from '@nats-io/nats-core';

import type { TokenSource } from './auth/types.ts';
import { forVariant, resourceOf, type Contract, type Resource } from './describe.ts';
import { decodeReply, failureOf, type Reply } from './envelope.ts';
import {
  JikuError,
  JikuInvalidRequest,
  JikuNoEndpoint,
  JikuNotConnected,
  JikuPermissionDenied,
  JikuTimeout,
} from './errors.ts';
import {
  getPayload,
  hasMore,
  listPayload,
  type Collection,
  type GetQuery,
  type ListQuery,
  type Page,
  type TagGroup,
} from './query.ts';
import {
  FORBIDDEN_COMMAND_FIELDS,
  FORBIDDEN_QUERY_IDENTITY_FIELDS,
  SERVICE_COMMANDS,
  SERVICE_QUERIES,
  splitMethod,
  subject as buildSubject,
  type Service,
} from './subject.ts';

/**
 * The per-request bus timeout, in milliseconds.
 *
 * The server's `NATS_QUERY_TIMEOUT_MS` is 10s and PostgreSQL's `statement_timeout` is 8s, so the
 * database cuts first and the caller gets `query_timeout` rather than silence. A client timeout
 * below 10s would break that ordering and turn an explained failure back into a mute one, so the
 * default sits above it.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** The deployment token of every subject when none is given. */
export const DEFAULT_INSTANCE = 'dev';

/** How often the client refreshes the token it hands the bus on reconnect. */
const TOKEN_REFRESH_INTERVAL_MS = 30_000;

/** Options every request-shaped method accepts. */
export interface RequestOptions {
  /**
   * Abandons the wait for a reply.
   *
   * It stops this client waiting; it does not un-publish the request, and core may well go on
   * to run it. There is no cancellation on this bus — request/reply over core NATS has nowhere
   * to put one.
   */
  signal?: AbortSignal | undefined;
  /** Overrides the client's timeout for this one request, in milliseconds. */
  timeoutMs?: number | undefined;
}

/** What a {@link Client} needs beyond an open connection. */
export interface ClientOptions {
  /**
   * The deployment token of every subject: `dev` or `prod`.
   *
   * Getting it wrong produces a request nobody is subscribed to, which looks exactly like a
   * timeout.
   */
  instance?: string | undefined;
  /**
   * The caller identity used in subjects: the Zitadel token's `sub`.
   *
   * `connect()` derives it from the token and you should not set it. The callout only authorises
   * publishing under one's own id, so a value that disagrees with the token produces an
   * authorization violation rather than access to somebody else's namespace.
   */
  userId: string;
  /** The per-request bus timeout in milliseconds. See {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number | undefined;
  /**
   * The token source, when the client should keep the connection's token fresh.
   *
   * `connect()` passes it. Without one the client still works, but a reconnect after the token
   * expires is refused by the callout.
   */
  auth?: TokenSource | undefined;
  /** Called when a background token refresh fails. Defaults to a warning on the console. */
  onTokenError?: ((error: unknown) => void) | undefined;
}

/**
 * A connection to Jiku's bus.
 *
 * It is safe for concurrent use and should be long-lived: one per process, not one per request.
 * Connecting costs a round trip to the identity provider and a NATS handshake that runs the
 * auth-callout.
 *
 * Build one with `connect()` rather than this constructor; {@link Client.fromConnection} exists
 * for the case where you already have an authenticated {@link NatsConnection} and want this
 * library's protocol layer over it.
 */
export class Client {
  readonly #nc: NatsConnection;
  readonly #instance: string;
  readonly #userId: string;
  readonly #timeoutMs: number;
  readonly #auth: TokenSource | undefined;
  readonly #inboxPrefix: string;

  #contract: Promise<Contract> | undefined;
  #closed = false;
  #refreshTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * The last SUBSCRIPTION permissions violation seen on this connection, if any.
   *
   * PUBLISH violations need no bookkeeping: the NATS client correlates them to the in-flight
   * request and rejects it immediately, so `#requestError` finds one as the `cause` and reports
   * it in milliseconds rather than after the full timeout.
   *
   * A SUBSCRIPTION violation is different and much nastier. It is terminal for the subscription
   * and it is reported on the status stream ONLY — the request that was waiting on that inbox
   * simply times out. That is the single most expensive failure on this bus, and remembering the
   * violation is what lets a timeout say "your inbox was refused" instead of "core did not
   * answer". It can only happen to a connection this library did not open; see
   * {@link Client.fromConnection}.
   */
  #subscriptionViolation: PermissionViolationError | undefined;

  private constructor(nc: NatsConnection, options: ClientOptions, inboxPrefix: string) {
    this.#nc = nc;
    this.#instance = options.instance || DEFAULT_INSTANCE;
    this.#userId = options.userId;
    this.#timeoutMs =
      options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.#auth = options.auth;
    this.#inboxPrefix = inboxPrefix;

    void this.#watchStatus();
    this.#startTokenRefresh(options.onTokenError);
  }

  /**
   * Wraps an already-authenticated {@link NatsConnection}.
   *
   * The connection MUST have been opened with the inbox prefix this bus requires — see
   * `inboxPrefix()` — or every request will time out with no error anywhere you can see it.
   * `connect()` does that for you; this entry point is for a process that opened its own
   * connection and wants the protocol layer on top.
   */
  static fromConnection(nc: NatsConnection, options: ClientOptions): Client {
    if (!options.userId) {
      throw new JikuInvalidRequest(
        "jiku: a client needs a userId — the Zitadel token's `sub`, which is the caller " +
          'identity in every subject',
      );
    }
    return new Client(nc, options, `_INBOX.${options.userId}`);
  }

  /** @internal Used by the transports, which have already computed the inbox prefix. */
  static create(nc: NatsConnection, options: ClientOptions, inboxPrefix: string): Client {
    return new Client(nc, options, inboxPrefix);
  }

  /** The caller identity in every subject: the Zitadel `sub`. */
  get userId(): string {
    return this.#userId;
  }

  /** The deployment token of every subject. */
  get instance(): string {
    return this.#instance;
  }

  /** The inbox this connection subscribes to, for diagnostics. */
  get inboxPrefix(): string {
    return this.#inboxPrefix;
  }

  /** The per-request timeout in milliseconds. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * The underlying NATS connection, for callers that need something this package does not wrap.
   *
   * The connection is already correctly authenticated and has the right inbox prefix, so
   * building on it is safe. Import the NATS API from `@gravadigital/jiku/nats` to be sure you
   * are using the same copy of the library this connection came from.
   */
  get connection(): NatsConnection {
    return this.#nc;
  }

  /** The server actually in use, which matters when several were listed. */
  get connectedUrl(): string {
    return this.#nc.isClosed() ? '' : this.#nc.getServer();
  }

  /** Whether {@link close} has been called. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Drains and closes the connection.
   *
   * Draining rather than closing outright: in-flight replies are delivered before the socket
   * goes away, so a request that was already answered is not lost on shutdown.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#refreshTimer !== undefined) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    if (!this.#nc.isClosed()) {
      await this.#nc.drain();
    }
  }

  /**
   * Supports `await using client = await connect(...)`.
   *
   * That SYNTAX needs Node 24, or a TypeScript build targeting something older, which downlevels
   * it. This package supports Node 22, where it is a syntax error — so `close()` in a `finally`
   * is what the examples use.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Publishes a request and returns the decoded envelope, WITHOUT turning a failure into an
   * error.
   *
   * Use it when you want to inspect a failure rather than handle it as one; {@link query} and
   * {@link command} are the usual entry points.
   */
  async request<T = unknown>(
    service: Service,
    method: string,
    payload?: unknown,
    options: RequestOptions = {},
  ): Promise<Reply<T>> {
    if (this.#closed || this.#nc.isClosed()) {
      throw new JikuNotConnected();
    }

    const body = encodePayload(service, payload);
    const subject = buildSubject(this.#instance, this.#userId, service, method);
    const timeoutMs =
      options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : this.#timeoutMs;

    // The transport and the decode are two separate try blocks on purpose. Wrapping both would
    // let #requestError swallow a decode error — which carries the raw bytes and is far more
    // useful than "requesting <subject> failed".
    let message: Msg;
    try {
      message = await race(this.#nc.request(subject, body, { timeout: timeoutMs }), options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason;
      }
      throw this.#requestError(subject, method, timeoutMs, error);
    }

    return decodeReply<T>(message.data, method);
  }

  /** Publishes to the read plane and returns the envelope's data, throwing on a failure. */
  async query<T = unknown>(
    method: string,
    payload?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return this.#do<T>(SERVICE_QUERIES, method, payload, options);
  }

  /**
   * Publishes to the write plane and returns the envelope's data, throwing on a failure.
   *
   * # A COMMAND IS NOT THE MIRROR IMAGE OF A QUERY
   *
   * Three asymmetries, all deliberate on core's side:
   *
   *   - The product roles authorise NO command. A person's token cannot write here, by the bus
   *     template AND by core's role map — two independent layers. Writes go through the api.
   *   - The acting person travels in the BODY (`creator`, `author`, `editor`), because the
   *     subject identifies the SERVICE that published, not the human behind it.
   *   - There is no JetStream and no retry. If core is down the request times out and the
   *     operation did not happen.
   */
  async command<T = unknown>(
    method: string,
    payload?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return this.#do<T>(SERVICE_COMMANDS, method, payload, options);
  }

  async #do<T>(
    service: Service,
    method: string,
    payload?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const reply = await this.request<T>(service, method, payload, options);
    const failure = failureOf(reply, method);
    if (failure) {
      throw failure;
    }
    return reply.data as T;
  }

  /**
   * Runs a `{resource}.list`.
   *
   * ```ts
   * const page = await client.list<Task>('tasks', {
   *   filter: { projectId: 15, state: anyOf('backlog', 'activo') },
   *   sort: ['-createdAt'],
   *   limit: 20,
   * });
   * ```
   */
  async list<T = unknown>(
    resource: string,
    query: ListQuery = {},
    options?: RequestOptions,
  ): Promise<Collection<T>> {
    // `unknown`, not Collection<T>: what came back is bytes core sent, and asserting the shape
    // before checking it would make the check below dead code the compiler is right to flag.
    const data: unknown = await this.query(`${resource}.list`, listPayload(query), options);
    if (
      typeof data !== 'object' ||
      data === null ||
      !Array.isArray((data as Collection<T>).items) ||
      typeof (data as Collection<T>).page !== 'object'
    ) {
      throw new JikuError(
        `jiku: the ${resource}.list reply is not a collection (expected {items, page})`,
      );
    }
    return data as Collection<T>;
  }

  /**
   * Runs a `{resource}.get`.
   *
   * A `*_not_found` does not distinguish "does not exist" from "you may not see it", on purpose:
   * telling them apart would confirm to an external caller that the record exists.
   */
  async get<T = unknown>(resource: string, query: GetQuery, options?: RequestOptions): Promise<T> {
    return this.query<T>(`${resource}.get`, getPayload(query), options);
  }

  /**
   * Walks every page of a list, following cursors.
   *
   * It exists because the end of a collection is signalled by the ABSENCE of a cursor, and a
   * hand-rolled loop that checks anything else — a page smaller than the limit, for instance —
   * is wrong: the byte budget can cut a page short and still emit a cursor.
   *
   * ```ts
   * for await (const task of client.iterate<Task>('tasks', { filter: { projectId: 15 } })) {
   *   console.log(task.title);
   * }
   * ```
   *
   * Iterating is not a snapshot: each page is its own query, so a record inserted between pages
   * may appear and one deleted may vanish. The keyset cursor guarantees no row is SKIPPED for a
   * stable ordering, which is the property that matters for a full sweep.
   *
   * Nothing is requested until the first iteration.
   */
  async *iterate<T = unknown>(
    resource: string,
    query: ListQuery = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    let cursor = query.cursor;
    for (;;) {
      const page = await this.list<T>(
        resource,
        cursor === undefined ? query : { ...query, cursor },
        options,
      );
      yield* page.items;

      // The ONLY end-of-collection signal. Not `items.length < limit`: the byte budget can cut
      // a page short and still emit a cursor, and stopping there would silently truncate.
      if (!hasMore(page.page)) {
        return;
      }
      cursor = page.page.cursor;
    }
  }

  /**
   * Walks every page and hands you each page whole, rather than each item.
   *
   * Use it when the per-page metadata matters — a progress bar, a cursor to store, the effective
   * limit after clamping.
   */
  async *iteratePages<T = unknown>(
    resource: string,
    query: ListQuery = {},
    options?: RequestOptions,
  ): AsyncGenerator<Collection<T>, void, undefined> {
    let cursor = query.cursor;
    for (;;) {
      const page = await this.list<T>(
        resource,
        cursor === undefined ? query : { ...query, cursor },
        options,
      );
      yield page;
      if (!hasMore(page.page)) {
        return;
      }
      cursor = page.page.cursor;
    }
  }

  /**
   * Collects every item of a list, following every cursor.
   *
   * Convenient and dangerous in the same way: it holds the whole collection in memory and issues
   * as many requests as it takes. Use {@link iterate} for anything that might be large.
   */
  async all<T = unknown>(
    resource: string,
    query: ListQuery = {},
    options?: RequestOptions,
  ): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this.iterate<T>(resource, query, options)) {
      out.push(item);
    }
    return out;
  }

  /**
   * Runs the first page of a list and returns the total, without holding the rows.
   *
   * `count: 'only'` skips the rows query entirely, so this costs one query over the filter's
   * universe and nothing else.
   */
  async count(
    resource: string,
    query: Omit<ListQuery, 'count' | 'cursor'> = {},
    options?: RequestOptions,
  ): Promise<number> {
    const page = await this.list(resource, { ...query, count: 'only' }, options);
    const total = page.page.total;
    if (typeof total !== 'number') {
      throw new JikuError(
        `jiku: ${resource}.list was asked for a count and answered without a total`,
      );
    }
    return total;
  }

  /** Runs `requirements.tags`, the one query with a shape of its own. It is not paginated. */
  async tags(projectId: number, key?: string, options?: RequestOptions): Promise<TagGroup[]> {
    const filter: Record<string, unknown> = { projectId };
    if (key) {
      filter['key'] = key;
    }
    const data: unknown = await this.query('requirements.tags', { filter }, options);
    const items = (data as { items?: TagGroup[] } | null)?.items;
    return Array.isArray(items) ? items : [];
  }

  /**
   * Fetches the contract, for all resources or for the named ones.
   *
   * An EMPTY (but present) `resources` list is `invalid_fields` on the server, not "all" — so
   * passing no names here means "all", which is what a caller passing no arguments means.
   */
  async describe(resources: string[] = [], options?: RequestOptions): Promise<Contract> {
    const payload: Record<string, unknown> = {};
    if (resources.length > 0) {
      payload['resources'] = resources;
    }
    const data: unknown = await this.query('meta.describe', payload, options);
    const declared: unknown = (data as Contract | null)?.resources;
    if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
      throw new JikuError('jiku: the meta.describe reply carries no `resources`');
    }
    return data as Contract;
  }

  /**
   * Returns the full contract, fetching it once per client and caching it.
   *
   * The cache is per client, so it lives as long as the connection and no longer. Nothing is
   * written to disk here: a contract cached across runs is a contract that can be wrong after a
   * deploy, and this one costs a single request that touches no database.
   */
  async contract(options?: RequestOptions): Promise<Contract> {
    // The PROMISE is cached, not the result: two concurrent callers on a cold cache would
    // otherwise both issue the request.
    this.#contract ??= this.describe([], options).catch((error: unknown) => {
      this.#contract = undefined;
      throw error;
    });
    return this.#contract;
  }

  /**
   * Fetches one resource's whitelists, resolving a variant when the resource is discriminated.
   *
   * Convenience over {@link contract} plus `resourceOf` plus `forVariant`, which is the sequence
   * anybody validating a query ends up writing.
   */
  async resource(name: string, variant?: string, options?: RequestOptions): Promise<Resource> {
    const contract = await this.contract(options);
    return forVariant(resourceOf(contract, name), variant);
  }

  /**
   * Watches the connection's status stream for a refused INBOX subscription.
   *
   * Publish violations do not come through here — the NATS client fails the request itself. What
   * does is a subscription the callout would not grant, which is silent everywhere else: the
   * client believes it subscribed, the server logged the refusal, and every request afterwards
   * times out.
   */
  async #watchStatus(): Promise<void> {
    try {
      for await (const status of this.#nc.status()) {
        this.#noteStatus(status);
      }
    } catch {
      // The status stream ends when the connection closes. That is not an error worth
      // surfacing: close() is the caller's own doing, and a connection that died has already
      // failed every in-flight request with something more specific.
    }
  }

  #noteStatus(status: Status): void {
    if (status.type !== 'error') {
      return;
    }
    const error = status.error;
    if (error instanceof PermissionViolationError && error.operation === 'subscription') {
      this.#subscriptionViolation = error;
    }
  }

  /**
   * Keeps {@link TokenSource.currentToken} fresh so a reconnect never presents an expired token.
   *
   * The interval is short and the work is usually nothing: a token source caches, and only talks
   * to the identity provider when the cached token is within a minute of expiry. The timer is
   * unref'd on Node so it never holds a process open on its own.
   */
  #startTokenRefresh(onError?: (error: unknown) => void): void {
    const auth = this.#auth;
    if (!auth) {
      return;
    }
    const report =
      onError ??
      ((error: unknown) => {
        console.warn(
          '[jiku] refreshing the Zitadel token failed; a reconnect after the current token ' +
            'expires will be refused:',
          error,
        );
      });

    this.#refreshTimer = setInterval(() => {
      if (this.#closed) {
        return;
      }
      void auth.token().catch(report);
    }, TOKEN_REFRESH_INTERVAL_MS);

    // Node and Bun return a Timeout object with unref(); a browser returns a number.
    (this.#refreshTimer as { unref?: () => void }).unref?.();
  }

  /** Explains the ways a request fails on the transport, all of which are routinely misdiagnosed. */
  #requestError(subject: string, method: string, timeoutMs: number, error: unknown): Error {
    // A RequestError wraps the real reason; the NATS client reports a refused PUBLISH as the
    // `cause` and rejects at once, which is why this arrives in milliseconds rather than after
    // the whole timeout.
    const cause = error instanceof RequestError ? error.cause : error;

    if (error instanceof PermissionViolationError) {
      return this.#permissionError(subject, method, error);
    }
    if (cause instanceof PermissionViolationError) {
      return this.#permissionError(subject, method, cause);
    }

    if (
      cause instanceof NoRespondersError ||
      (error instanceof RequestError && error.isNoResponders())
    ) {
      // Distinctly better news than a timeout: the server answered AT ONCE that nothing is
      // subscribed to this subject. So it is not a slow core and not the inbox — the subject
      // itself reaches nobody, which almost always means the method does not exist.
      const parts = splitMethod(method);
      const read = parts
        ? ` (read as resource ${JSON.stringify(parts.resource)}, operation ${JSON.stringify(parts.operation)})`
        : '';
      return new JikuNoEndpoint(
        `jiku: nothing is listening on ${method}\n` +
          '  The bus answered immediately that no endpoint is registered for that subject, so ' +
          'this is\n  neither a slow core nor an inbox problem:\n' +
          '    - is the method spelled right? core answers only what it registers, and no ' +
          `subject\n      here carries a wildcard${read}\n` +
          '    - is it on the right plane? queries and commands are separate services\n' +
          `    - is the instance right? this asked on ${JSON.stringify(subject)}\n` +
          '  `client.describe()` lists the reads core serves; the 20 commands are in ' +
          'docs/commands.md.',
        { cause: error },
      );
    }

    if (cause instanceof TimeoutError || error instanceof TimeoutError) {
      // The inbox came back refused, so this timeout has one cause and only one. Saying so
      // beats the generic list: the reply WAS published, to a subject this connection is not
      // subscribed to, and no amount of looking at core will show that.
      const refused = this.#subscriptionViolation;
      if (refused) {
        return new JikuTimeout(
          `jiku: ${method} did not answer within ${timeoutMs}ms, and it never could have\n` +
            `  The bus REFUSED this connection's inbox subscription (${refused.subject}), so ` +
            'the reply was\n  published where nobody is listening. Core is not the problem and ' +
            'neither is the method.\n' +
            `  A connection to this bus may subscribe to exactly one inbox, _INBOX.<hash(sub)>. ` +
            `This one\n  used ${this.#inboxPrefix}, which the callout did not grant — so it was ` +
            'opened with a userId that\n  disagrees with the token, or without the prefix at ' +
            'all. connect() from this package always\n  sets it correctly; ' +
            'Client.fromConnection() trusts the connection you hand it.',
          { cause: error },
        );
      }
      return new JikuTimeout(
        `jiku: ${method} did not answer within ${timeoutMs}ms\n` +
          '  Nothing replied, which on this bus is usually NOT a slow core:\n' +
          `    - is the instance right? This asked on ${JSON.stringify(subject)} — a wrong ` +
          'instance means nobody is subscribed\n' +
          '    - is the method right? `client.describe()` lists what core serves\n' +
          '    - is core running and subscribed?\n' +
          '  (The inbox prefix, the other classic cause, is set correctly by this client: ' +
          `${this.#inboxPrefix})`,
        { cause: error },
      );
    }

    return new JikuError(`jiku: requesting ${subject}`, { cause: error });
  }

  /**
   * Explains a refusal by the BUS, which is a different thing from a refusal by core and has a
   * different fix.
   *
   * The distinction is worth spelling out every time: the bus refuses by subject, before core
   * sees anything; core refuses by role and by its own `users` table, after. A caller who
   * confuses the two goes looking in the wrong service.
   */
  #permissionError(subject: string, method: string, cause: unknown): JikuPermissionDenied {
    let plane = 'that subject';
    if (subject.includes(`.${SERVICE_COMMANDS}.`)) {
      plane = 'the COMMAND plane';
    } else if (subject.includes(`.${SERVICE_QUERIES}.`)) {
      plane = 'the QUERY plane';
    }
    return new JikuPermissionDenied(
      `jiku: the bus refused to publish ${method} (${subject})\n` +
        '  This is the BUS refusing by subject, not core refusing by role — the message never\n' +
        "  reached core at all, so nothing about core's authorisation is implied either way.\n" +
        `  Your token's role selected a permission template that does not grant ${plane}.\n` +
        "  Which roles may publish which plane is the deployment's choice, set in the\n" +
        "  auth-callout's template for your role. Historically the product roles (admin, user,\n" +
        '  external-user) have been granted the query plane only, with writes going through\n' +
        '  the api — but that is policy, not a property of this client.',
      subject,
      method,
      { cause },
    );
  }
}

/**
 * Turns a payload into request bytes, rejecting the forbidden identity fields locally so the
 * round trip is not spent learning about them.
 *
 * A missing payload becomes `{}` rather than an empty body: several endpoints take no arguments,
 * and an empty body is not valid JSON for a validator that expects an object.
 */
export function encodePayload(service: Service, payload?: unknown): Uint8Array {
  const encoder = new TextEncoder();

  if (payload === undefined || payload === null) {
    return encoder.encode('{}');
  }

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed === '') {
      return encoder.encode('{}');
    }
    checkNoIdentityFields(service, parseObject(trimmed));
    return encoder.encode(trimmed);
  }

  if (payload instanceof Uint8Array) {
    checkNoIdentityFields(service, parseObject(new TextDecoder().decode(payload)));
    return payload;
  }

  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch (cause) {
    throw new JikuInvalidRequest('jiku: invalid request: the payload cannot be encoded as JSON', {
      cause,
    });
  }
  // TypeScript types JSON.stringify as returning `string`, and that is simply wrong: it
  // returns undefined for a function, a symbol or undefined itself. Trusting the type here
  // would publish the four bytes "unde".
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (json === undefined) {
    throw new JikuInvalidRequest(
      'jiku: invalid request: the payload encodes to nothing (a function or a symbol?)',
    );
  }
  const probe: unknown = JSON.parse(json);
  if (typeof probe === 'object' && probe !== null && !Array.isArray(probe)) {
    checkNoIdentityFields(service, probe as Record<string, unknown>);
  }
  return encoder.encode(json);
}

function parseObject(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new JikuInvalidRequest('jiku: invalid request: the payload is not valid JSON', {
      cause,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new JikuInvalidRequest('jiku: invalid request: the payload is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Reports the first forbidden key present in a payload, for the given service. */
export function checkNoIdentityFields(service: Service, payload: Record<string, unknown>): void {
  if (service === SERVICE_COMMANDS) {
    for (const name of FORBIDDEN_COMMAND_FIELDS) {
      if (name in payload) {
        throw new JikuInvalidRequest(
          `jiku: invalid request: ${JSON.stringify(name)} is the reserved identity envelope of ` +
            "the command plane, and only the api's own service user may carry it — core " +
            "answers invalid_fields to anybody else. Your identity is already the token's " +
            '`sub` in the subject. (Domain fields naming a person — creator, editor, author, ' +
            'uploader, personId, userId — are fine and are not this.)',
        );
      }
    }
    return;
  }

  for (const name of FORBIDDEN_QUERY_IDENTITY_FIELDS) {
    if (name in payload) {
      throw new JikuInvalidRequest(
        `jiku: invalid request: ${JSON.stringify(name)} is a forbidden identity field on the ` +
          'read plane — the caller comes from the subject and only from the subject, so core ' +
          "answers invalid_fields. Remove it; your identity is already the token's `sub`",
      );
    }
  }
}

/**
 * Races a promise against one or two abort signals.
 *
 * The NATS request API takes a timeout but no signal, so cancellation is implemented here. It
 * stops the WAIT, not the request: the message is already published and core may still run it.
 */
function race<T>(promise: Promise<T>, ...signals: (AbortSignal | undefined)[]): Promise<T> {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    const settle = (fn: () => void): void => {
      for (const cleanup of cleanups) {
        cleanup();
      }
      fn();
    };
    for (const signal of present) {
      if (signal.aborted) {
        settle(() => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason);
        });
        return;
      }
      const onAbort = (): void => {
        settle(() => {
          // Whatever the caller passed to abort() is what they get back, Error or not. Wrapping
          // it would hide the reason they chose.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason);
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => {
        signal.removeEventListener('abort', onAbort);
      });
    }
    promise.then(
      (value) => {
        settle(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        settle(() => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        });
      },
    );
  });
}

/** Re-exported so `Page` is reachable from the client module too. */
export type { Page };
