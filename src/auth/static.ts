import { JikuError } from '../errors.ts';
import { decodeClaims, expiryOf } from './claims.ts';
import { isFresh, type TokenSource, type TokenSourceOptions } from './types.ts';

/**
 * A {@link TokenSource} backed by one token you already have.
 *
 * # THIS IS THE BROWSER'S PATH, AND IT IS NOT A SHORTCUT
 *
 * A browser application has already authenticated its user — with Zitadel's own web SDK, an
 * authorization-code + PKCE flow, or a session its backend owns — and is holding an access
 * token. There is nothing left for this library to do but present it. Minting a second token
 * through a second flow would be worse in every way.
 *
 * The token is NOT refreshed. When it expires, the connection's next reconnect is refused, which
 * is exactly the failure {@link tokenGetter} exists to avoid — prefer that one for anything
 * long-lived.
 *
 * @throws {JikuError} when the token is not a readable JWT, because the `sub` is needed to build
 * every subject and the inbox prefix, and there is nowhere else to get it.
 */
export function staticToken(token: string): TokenSource {
  const trimmed = token.trim();
  if (trimmed === '') {
    throw new JikuError('jiku/auth: staticToken() was given an empty token');
  }
  const claims = decodeClaims(trimmed);
  const sub = claims.sub;
  if (!sub) {
    throw new JikuError(
      'jiku/auth: the token carries no `sub`, so there is no caller identity to build ' +
        'subjects from',
    );
  }
  return {
    // Promise.resolve rather than `async`: there is nothing to await, and saying so keeps the
    // signature honest about doing no work.
    token: () => Promise.resolve(trimmed),
    currentToken: () => trimmed,
    subject: () => Promise.resolve(sub),
    expiresAt: () => expiryOf(trimmed),
  };
}

/** What {@link tokenGetter} needs from you. */
export interface TokenGetterOptions {
  /**
   * Returns a currently-valid access token. Called on the first connect and again whenever the
   * cached token comes within a minute of expiry.
   *
   * Make it cheap when nothing has to change: return the token you already hold, and only reach
   * for your identity provider when it is close to expiring.
   */
  getToken: (options?: TokenSourceOptions) => string | Promise<string>;
  /**
   * The `sub` of the identity, when you already know it.
   *
   * Omit it and the token's own `sub` claim is used, which is the right answer for any real
   * Zitadel token. Provide it only when your tokens are opaque.
   */
  subject?: string | undefined;
}

/**
 * A {@link TokenSource} that asks your callback for a token whenever one is needed.
 *
 * This is the general-purpose adapter: use it to plug in a session your own code manages, a
 * secret manager, a sidecar, or a token endpoint this library does not implement.
 *
 * ```ts
 * const auth = tokenGetter({ getToken: () => session.accessToken() });
 * ```
 *
 * The callback's result is cached until a minute before the token's `exp`, so a callback that
 * does real work is not called on every reconnect.
 */
export function tokenGetter(options: TokenGetterOptions): TokenSource {
  let cached = '';
  let expiry: Date | undefined;
  let inFlight: Promise<string> | undefined;
  let knownSubject = options.subject;

  const refresh = async (opts?: TokenSourceOptions): Promise<string> => {
    // The callback is the caller's code; its return value is untrusted no matter what the type
    // promises, and an empty or missing token has to be named here rather than at the handshake.
    const returned: unknown = await options.getToken(opts);
    const token = typeof returned === 'string' ? returned.trim() : '';
    if (!token) {
      throw new JikuError('jiku/auth: the getToken callback returned no token');
    }
    cached = token;
    expiry = expiryOf(token);
    if (!knownSubject) {
      const sub = decodeClaims(token).sub;
      if (!sub) {
        throw new JikuError(
          'jiku/auth: the token carries no `sub` and no subject was configured, so there is ' +
            'no caller identity to build subjects from. Pass `subject` to tokenGetter() if ' +
            'your tokens are opaque',
        );
      }
      knownSubject = sub;
    }
    return token;
  };

  return {
    async token(opts) {
      if (cached && isFresh(expiry)) {
        return cached;
      }
      // One in-flight refresh at a time. Without this, a reconnect storm turns into a burst of
      // identical token requests, and providers rate-limit exactly that.
      inFlight ??= refresh(opts).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    currentToken: () => cached,
    async subject(opts) {
      if (knownSubject) {
        return knownSubject;
      }
      await this.token(opts);
      return knownSubject as string;
    },
    expiresAt: () => expiry,
  };
}
