/**
 * A client for Jiku's API, which is served over NATS rather than HTTP: 23 read endpoints
 * (queries) and 20 write endpoints (commands), request/reply, no REST anywhere.
 *
 * # Getting started
 *
 * ```ts
 * import { connect, anyOf } from '@gravadigital/jiku';
 * import { ServiceUser } from '@gravadigital/jiku/node';
 *
 * const auth = await ServiceUser.fromKeyFile('/etc/jiku/service-account.json', {
 *   issuer: 'https://id.grava.io',
 *   projectId: '275672248377933829',
 * });
 *
 * const client = await connect({
 *   servers: 'nats://localhost:4222',
 *   instance: 'dev',
 *   credsFile: '/etc/jiku/sentinel-client.creds',
 *   auth,
 * });
 *
 * const page = await client.list<Task>('tasks', {
 *   filter: { projectId: 15, state: anyOf('backlog', 'activo') },
 *   sort: ['-createdAt'],
 *   limit: 20,
 * });
 *
 * await client.close();
 * ```
 *
 * # Why this package exists rather than a bare NATS client
 *
 * The request itself is not complicated. Three things about this bus are, and each fails in a
 * way that does not point at its cause:
 *
 * **THE INBOX PREFIX.** A connection may subscribe to exactly one inbox, `_INBOX.<hash(sub)>`.
 * Anything else — including the random default every NATS client generates — means the reply is
 * published where you are not listening. The request then times out with no error visible to the
 * caller: the permissions violation is recorded in the NATS SERVER's log. `connect()` always
 * sets it; see {@link inboxPrefix}.
 *
 * **TWO CREDENTIALS, ONE OF WHICH GRANTS NOTHING.** The sentinel creds file denies itself
 * publish and subscribe on `>`. What mints permissions is a Zitadel access token, and it must
 * carry a roles claim — which it only does if the reserved Zitadel scopes were requested. See
 * `@gravadigital/jiku/auth`.
 *
 * **TOKENS AND RECONNECTS.** The auth-callout evaluates the token at connect time, and NATS does
 * not re-check afterwards. A reconnect re-runs the callout, so a token that expired in the
 * meantime means the reconnect is refused. `connect()` hands the bus a function rather than a
 * frozen string, and keeps the token behind it fresh.
 *
 * # Reads are deny-by-default
 *
 * Every resource declares five closed lists — base, includable, filterable, sortable and an
 * external scope. A name that is not declared DOES NOT EXIST: it answers `invalid_fields`, never
 * a silently ignored lever. An ignored filter would return more data than was asked for.
 *
 * Fetch those lists with {@link Client.contract}, which calls `meta.describe` — the same
 * structures the server's validator reads, so they cannot drift from it. {@link validateQuery}
 * checks a query against them before it is published.
 *
 * # Filters: the operator is the shape of the value
 *
 * ```text
 * scalar                      equality
 * array                       IN
 * {not: ...}                  negation
 * {gte: x, lte: y}            range
 * {key: k, value: v}          containment
 * ```
 *
 * Use the builders — {@link anyOf}, {@link not}, {@link between}, {@link gte},
 * {@link contains} — rather than writing the objects by hand.
 *
 * # Pagination
 *
 * The ABSENCE of a cursor is the only end-of-collection signal. There is no `hasMore` field, and
 * a page can come back shorter than the limit because of a byte budget — so a short page does
 * not mean the end. Use {@link Client.iterate} rather than a hand-rolled loop.
 *
 * # Reads and writes are not symmetric
 *
 * The product roles (admin, user, external-user) authorise every query and NO command, enforced
 * both by the bus permission template and by core's own role map. Writes go through the api over
 * HTTP, because core does not hold the business rules that depend on the end user. Commands are
 * for service identities.
 *
 * # Errors
 *
 * A failure envelope becomes a {@link JikuFailure}. Test a specific code with {@link isCode},
 * and call `hint()` for advice on the codes whose name does not explain the cause. Requests this
 * package rejects locally — a forbidden identity field, an undeclared name — are a
 * {@link JikuInvalidRequest} and never reach the network.
 *
 * @module
 */

export {
  Client,
  DEFAULT_INSTANCE,
  DEFAULT_TIMEOUT_MS,
  checkNoIdentityFields,
  encodePayload,
} from './client.ts';
export type { ClientOptions, RequestOptions } from './client.ts';

export {
  DEFAULT_ISSUER,
  DEFAULT_SERVERS,
  ENV,
  parseServers,
  resolveOptions,
  transportOf,
} from './config.ts';
export type { ConnectOptions, ResolvedConnectOptions } from './config.ts';

export {
  assertValidQuery,
  coerce,
  coerceKind,
  fieldNames,
  filterableNames,
  forVariant,
  includableNames,
  resourceNames,
  resourceOf,
  sortableNames,
  suggest,
  validateQuery,
  variantNames,
} from './describe.ts';
export type {
  Contract,
  Defaults,
  Discriminator,
  EnumValue,
  Field,
  Resource,
  Variant,
} from './describe.ts';

export { decodeReply, failureOf } from './envelope.ts';
export type { Reply, Status } from './envelope.ts';

export {
  ErrorCode,
  JikuError,
  JikuFailure,
  JikuInvalidRequest,
  JikuNoEndpoint,
  JikuNotConnected,
  JikuPermissionDenied,
  JikuTimeout,
  isCode,
  isJikuError,
} from './errors.ts';
export type { ErrorCodeValue, ErrorDetails, JikuFailureInit } from './errors.ts';

export { parseFilter } from './filter.ts';

export {
  anyOf,
  between,
  contains,
  getPayload,
  gt,
  gte,
  hasMore,
  listPayload,
  lt,
  lte,
  not,
  range,
} from './query.ts';
export type {
  Collection,
  ContainsCondition,
  CountOption,
  Filter,
  FilterValue,
  GetQuery,
  ListQuery,
  NotCondition,
  Page,
  RangeCondition,
  Scalar,
  TagGroup,
} from './query.ts';

export {
  FORBIDDEN_COMMAND_FIELDS,
  FORBIDDEN_QUERY_IDENTITY_FIELDS,
  PROTOCOL_VERSION,
  SERVICE_COMMANDS,
  SERVICE_QUERIES,
  hashUserId,
  inboxPrefix,
  splitMethod,
  subject,
} from './subject.ts';
export type { Service } from './subject.ts';

// The token-source contract is re-exported from the root because ConnectOptions names it, and a
// type you cannot import from the same specifier as the function that demands it is a papercut.
// Everything else about authentication lives in `@gravadigital/jiku/auth`.
export type { TokenSource, TokenSourceOptions } from './auth/types.ts';

export type { NatsConnection } from '@nats-io/nats-core';
