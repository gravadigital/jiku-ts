/**
 * Obtains Zitadel access tokens for a Jiku bus connection.
 *
 * # WHY A TOKEN IS WHAT MATTERS
 *
 * Connecting to Jiku's NATS needs two things, and only one of them is a secret worth guarding:
 *
 *  1. The sentinel creds — a NATS user JWT that grants NOTHING. Its own permissions are
 *     `pub.deny: [">"]` and `sub.deny: [">"]`. It exists to let the connection reach the
 *     auth-callout, nothing more.
 *  2. A Zitadel access token — THIS is what mints permissions. The callout validates it, reads
 *     the role, picks a template and returns a user JWT with real subject permissions for that
 *     connection.
 *
 * So the interesting work of authenticating to Jiku is entirely the work of getting a Zitadel
 * token, which is what this module does.
 *
 * # THE THREE MODES
 *
 * **Bring your own token** — a browser, or anything with a session of its own. The application
 * has already authenticated its user; there is nothing left to do but present the token.
 *
 * ```ts
 * import { tokenGetter } from '@gravadigital/jiku/auth';
 *
 * const auth = tokenGetter({ getToken: () => session.accessToken() });
 * ```
 *
 * **Device flow** — a person at a terminal, RFC 8628. You authorise once in a browser and the
 * tokens are kept in a store:
 *
 * ```ts
 * import { DeviceFlow } from '@gravadigital/jiku/auth';
 * import { FileStore, defaultStorePath } from '@gravadigital/jiku/node';
 *
 * const auth = new DeviceFlow({
 *   issuer: 'https://id.example.com',
 *   clientId: '987654321098765432@your_project',
 *   projectId: '987654321098765432',
 *   store: new FileStore(defaultStorePath('dev')),
 * });
 * ```
 *
 * **Service user** — a service, unattended, RFC 7523 JWT profile, from the JSON key Zitadel
 * hands you when you add a key to a machine user. It signs with a private key and so lives in
 * the Node-only entry point:
 *
 * ```ts
 * import { ServiceUser } from '@gravadigital/jiku/node';
 *
 * const auth = await ServiceUser.fromKeyFile('/etc/jiku/service-account.json', {
 *   issuer: 'https://id.example.com',
 *   projectId: '987654321098765432',
 * });
 * ```
 *
 * # TOKENS ARE FETCHED PER CONNECTION ATTEMPT, NOT ONCE
 *
 * The callout evaluates the token at CONNECT time and the resulting permissions live for the
 * life of the connection — NATS does not re-check. That is fine until the connection drops: a
 * reconnect re-runs the callout, and a token that has since expired means the reconnect is
 * refused. So a {@link TokenSource} is asked for a token on every (re)connect and is responsible
 * for returning a fresh one, which is why this is an interface and not a string.
 *
 * @module
 */

export { decodeClaims, expiryOf, roleNames, base64UrlDecode, base64UrlEncode } from './claims.ts';
export type { Claims } from './claims.ts';

export { staticToken, tokenGetter } from './static.ts';
export type { TokenGetterOptions } from './static.ts';

export { DeviceFlow, LoginRequired } from './device.ts';
export type { DeviceAuth, DeviceFlowOptions, Store } from './device.ts';

export {
  clearDiscoveryCache,
  discover,
  fetchUserinfo,
  OAuthError,
  postForm,
  projectScopes,
} from './oidc.ts';
export type { Discovery, HttpOptions, Tokens } from './oidc.ts';

export { isFresh, REFRESH_SKEW_MS } from './types.ts';
export type { TokenSource, TokenSourceOptions } from './types.ts';
