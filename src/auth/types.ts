/**
 * How long before real expiry a token is treated as expired.
 *
 * It absorbs clock skew between us and Zitadel plus the flight time of the request that is about
 * to use the token. A token that expires while the callout is validating it is refused, and the
 * symptom is an authorization violation on connect rather than anything about time.
 */
export const REFRESH_SKEW_MS = 60_000;

/** Options every asynchronous {@link TokenSource} method accepts. */
export interface TokenSourceOptions {
  signal?: AbortSignal | undefined;
}

/**
 * Yields a currently-valid Zitadel access token.
 *
 * # WHY THIS INTERFACE HAS BOTH AN ASYNC AND A SYNC ACCESSOR
 *
 * The NATS client asks for the token through an authenticator that is SYNCHRONOUS —
 * `tokenAuthenticator(() => string)` — and it calls it on every connect AND on every reconnect.
 * JavaScript cannot block there to mint a token, so the two halves are split:
 *
 *   - {@link token} is the async one. It mints or refreshes, and the client awaits it before
 *     connecting and again on a timer while connected.
 *   - {@link currentToken} is the sync one. It returns whatever the last successful
 *     {@link token} produced, and it is what the authenticator hands to the server.
 *
 * That split is the whole reason a long-lived connection survives a token expiry: the callout
 * evaluates the token at CONNECT time and the resulting permissions live for the life of the
 * connection — NATS does not re-check. A reconnect re-runs the callout, and a token that has
 * since expired means the reconnect is refused. {@link Client} keeps {@link currentToken} fresh
 * so that never happens.
 *
 * Implementations must be safe to call concurrently and should be fast in the common case:
 * cache, and only talk to the identity provider when the cached token is close to expiry.
 */
export interface TokenSource {
  /**
   * Returns a valid access token, refreshing or minting one when the cached one is close to
   * expiry.
   */
  token(options?: TokenSourceOptions): Promise<string>;

  /**
   * The last token {@link token} produced, synchronously and without I/O.
   *
   * Returns an empty string before the first successful {@link token}. Handing the server an
   * empty token is better than blocking: the connection is refused immediately with an
   * authorization violation instead of hanging.
   */
  currentToken(): string;

  /**
   * The `sub` of the identity behind the token.
   *
   * It is the caller's identity in every subject and the seed of its inbox prefix, so the client
   * needs it before it can build either.
   */
  subject(options?: TokenSourceOptions): Promise<string>;

  /**
   * When the current token stops being accepted, or `undefined` when that cannot be known.
   *
   * Optional: it exists so the client can log something useful and so a caller can check a
   * session without minting anything.
   */
  expiresAt?(): Date | undefined;
}

/** Reports whether a token is still usable, allowing for {@link REFRESH_SKEW_MS}. */
export function isFresh(expiry: Date | undefined, now = Date.now()): boolean {
  return expiry !== undefined && expiry.getTime() - REFRESH_SKEW_MS > now;
}
