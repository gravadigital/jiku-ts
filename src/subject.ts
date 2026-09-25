/**
 * Service names of the two micro services core registers on the bus.
 *
 * They are separate subject tokens on purpose, not nested under one prefix: two queue groups
 * over overlapping subjects would deliver each message to BOTH subscriptions, and a plain
 * `request()` returns the first reply and discards the second silently.
 */
export const SERVICE_QUERIES = 'jiku-queries';

/**
 * The write plane. Which roles may publish here is core's role map, not one rule — since
 * REQ-007 `admin` and `user` reach most commands directly and `external-user` reaches none.
 * See the role table in docs/auth.md.
 */
export const SERVICE_COMMANDS = 'jiku-commands';

/** The `{version}` token of the subject grammar. */
export const PROTOCOL_VERSION = 'v1';

/** The two planes, as a union, for anything that has to branch on one. */
export type Service = typeof SERVICE_QUERIES | typeof SERVICE_COMMANDS;

/**
 * Builds a request subject from the grammar core subscribes to:
 *
 * ```text
 * {instance}.{userId}.{service}.{version}.{method}
 * dev.123456789012345678.jiku-queries.v1.tasks.list
 * ```
 *
 * `userId` is the Zitadel token's `sub`, RAW, and it is the only source of caller identity:
 * the auth-callout authorises publishing under one's own id only, so the subject cannot be
 * forged while the body can. That is also why identity field names are rejected in payloads
 * (see {@link checkNoIdentityFields}).
 */
export function subject(instance: string, userId: string, service: string, method: string): string {
  return [instance, userId, service, PROTOCOL_VERSION, method].join('.');
}

/**
 * Base32 alphabet, RFC 4648, no padding: short, and free of `.`, `*` and `>`, none of which
 * may appear in a subject token.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  }
  return out;
}

/**
 * 16 base32 characters — 80 bits of the sha256, far more than enough to keep users from
 * colliding.
 */
const INBOX_HASH_LENGTH = 16;

/**
 * Derives the inbox token for a user id.
 *
 * It must reproduce, byte for byte, the hash the auth-callout computes. The callout uses it to
 * mint the subscribe permission and this client uses it to pick its inbox, with no channel
 * between them — so a disagreement is invisible until every request starts timing out. The test
 * vectors in test/fixtures/inbox-vectors.json pin values observed from a running callout, which
 * is what keeps the two honest.
 *
 * This hash hides nobody. The user id travels raw in every subject, so anyone who can see a
 * subject has already seen the id — the inbox just needs one opaque, fixed-length token.
 *
 * # WHY IT IS ASYNC
 *
 * It uses WebCrypto's `crypto.subtle.digest`, which is async and has no synchronous
 * counterpart that works in a browser. The alternative was a hand-rolled SHA-256, which is
 * not a thing a published library should carry. Nothing is lost: the only caller that
 * matters is `connect()`, which is async anyway, and {@link Client.inboxPrefix} is a plain
 * synchronous getter because the client computes this once and remembers it.
 */
export async function hashUserId(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
  return base32Encode(new Uint8Array(digest)).slice(0, INBOX_HASH_LENGTH).toLowerCase();
}

/**
 * The only inbox a caller is allowed to subscribe to:
 *
 * ```text
 * _INBOX.<hashUserId(sub)>
 * ```
 *
 * # THIS IS THE MOST EXPENSIVE MISTAKE ON THIS BUS
 *
 * The callout grants `sub.allow: _INBOX.{{user_id_hash}}.>` and nothing else. A client that
 * does not set this prefix gets the NATS library's default random `_INBOX.<nuid>`, which no
 * permission authorises. The reply is then published to a subject the client is not
 * subscribed to, so:
 *
 *   - the request TIMES OUT after the full timeout window,
 *   - no permissions error is returned to the caller,
 *   - and the violation is logged by the NATS SERVER, where nobody thinks to look.
 *
 * The symptom points at core being down or slow. It is neither. {@link connect} always sets
 * this, which is a large part of why this package exists — see docs/auth.md.
 */
export async function inboxPrefix(userId: string): Promise<string> {
  return `_INBOX.${await hashUserId(userId)}`;
}

/**
 * The closed list of payload keys the QUERY plane rejects with `invalid_fields`.
 *
 * On a read, the caller comes from the subject and ONLY from the subject: the auth-callout
 * authorises publishing under one's own id, so the subject is unforgeable while the body is
 * not. An ignored identity field would be worse than a rejected one — it would suggest a
 * caller may ask on somebody else's behalf and that the service merely did not listen this
 * time.
 *
 * THIS LIST IS FOR READS ONLY. See {@link FORBIDDEN_COMMAND_FIELDS} for why the write plane
 * is different.
 */
export const FORBIDDEN_QUERY_IDENTITY_FIELDS: readonly string[] = [
  'userId',
  'user_id',
  'user',
  'caller',
  'callerId',
  'caller_id',
  'sub',
  'identity',
  'actor',
  'principal',
  'onBehalfOf',
];

/**
 * The much shorter list the COMMAND plane rejects.
 *
 * # WHY THE TWO PLANES CANNOT SHARE ONE LIST
 *
 * Applying the read plane's list to writes rejects legitimate commands. Several command
 * payloads carry an identity as DOMAIN DATA rather than as a claim about who is calling:
 *
 * ```text
 * requirements.{id}.subscriptors.new   requires `userId` — who is being subscribed
 * worked-times.new                     takes `personId` — whose hours these are
 * the `new` and `edit` commands        take `creator` / `editor` / `author` / `uploader`
 * ```
 *
 * Those are arguments, not impersonation. Applying the read plane's list here makes
 * `subscriptors.new` impossible to send — which is refusing what the server accepts, the exact
 * failure this package exists to prevent.
 *
 * What DOES stay forbidden is `actor`: the reserved identity envelope the dispatcher extracts
 * before validating. Only the api's own service user (core's `CORE_TRUSTED_PUBLISHER_ID`) may
 * carry it; anybody else sending it is answered `invalid_fields`, deliberately reusing the
 * read plane's code because it is literally the same rule on the other side. A consumer of
 * this library is not that publisher, so sending `actor` can only be a mistake.
 */
export const FORBIDDEN_COMMAND_FIELDS: readonly string[] = ['actor'];

/**
 * Splits a method like `tasks.list` into its resource and operation.
 *
 * Returns `null` when the method has no operation half, which is a caller error rather than
 * a shape this library should invent a default for.
 */
export function splitMethod(method: string): { resource: string; operation: string } | null {
  const index = method.lastIndexOf('.');
  if (index <= 0 || index === method.length - 1) {
    return null;
  }
  return { resource: method.slice(0, index), operation: method.slice(index + 1) };
}
