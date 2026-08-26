import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { base64UrlEncode, decodeClaims, expiryOf, type Claims } from '../auth/claims.ts';
import { discover, postForm, projectScopes, type HttpOptions, type Tokens } from '../auth/oidc.ts';
import { isFresh, type TokenSource, type TokenSourceOptions } from '../auth/types.ts';
import { JikuError } from '../errors.ts';

/**
 * The JSON key file Zitadel produces for a machine user.
 *
 * ```json
 * {"type":"serviceaccount","keyId":"...","key":"-----BEGIN RSA PRIVATE KEY-----\n...",
 *  "userId":"...","expirationDate":"..."}
 * ```
 *
 * That file IS the credential. It cannot be re-downloaded — only replaced by a new key.
 */
export interface ServiceAccountKey {
  type?: string;
  keyId: string;
  key: string;
  userId: string;
  expirationDate?: string;
}

/**
 * Configures the JWT profile grant (RFC 7523) — the flow for a SERVICE.
 *
 * This is what an unattended integration should use: no browser, no refresh token, no stored
 * state. The private key IS the credential, and a fresh access token is minted whenever one is
 * needed.
 *
 * # WHERE THE KEY FILE COMES FROM
 *
 * In Zitadel: create a machine user, set Access Token Type to JWT, grant it a role in the
 * project, then add a KEY to it. Zitadel downloads a JSON file exactly once.
 *
 * # ACCESS TOKEN TYPE MUST BE JWT
 *
 * The auth-callout validates the token as a JWT against the issuer. A machine user left on the
 * default opaque `Bearer` token type gets a token the callout cannot read, and the connection is
 * refused. This is the single most common misconfiguration of this flow.
 */
export interface ServiceUserOptions extends HttpOptions {
  /** The Zitadel instance, e.g. `https://id.example.com`. */
  issuer: string;
  /**
   * Adds the two reserved Zitadel scopes.
   *
   * As with the device flow, the roles claim is what the callout reads to pick a permission
   * template, so a token minted without it connects to nothing.
   */
  projectId?: string | undefined;
  /**
   * Scopes to request. Defaults to `openid` and `profile`.
   *
   * `profile` LOOKS UNNECESSARY FOR A SERVICE AND IS NOT. Jiku's auth-callout publishes an
   * authentication event that core turns into a row in `users`, and core REQUIRES a name on that
   * event. A machine user's name reaches the callout through the userinfo endpoint, which only
   * returns it when `profile` was requested — so a token minted with `openid` alone produces a
   * nameless event, core discards it, no row is created, and every subsequent request is refused
   * with `caller_not_authorized`.
   *
   * The failure is silent and lands three services away from its cause: the bus accepts the
   * connection, the callout logs a success, and only core's log says
   * `[events] descartado: "name" is required`.
   */
  scopes?: string[] | undefined;
  /**
   * Overrides the `aud` of the signed assertion. Defaults to the issuer, which is what Zitadel
   * expects.
   */
  audience?: string | undefined;
  /**
   * The lifetime of the signed assertion in milliseconds. Defaults to one hour, the maximum
   * Zitadel accepts.
   */
  assertionTtlMs?: number | undefined;
}

const DEFAULT_ASSERTION_TTL_MS = 3_600_000;

/**
 * A {@link TokenSource} backed by a Zitadel service account key.
 *
 * It caches the access token in memory and mints a new one when the cached one nears expiry, so
 * a long-lived connection that reconnects always presents a live token. Nothing is written to
 * disk: the key is the only durable state, and it is the caller's to manage.
 *
 * It lives in the Node entry point because it signs with a private key, and a service-account
 * private key must never reach a browser. A browser should hand this library the access token it
 * already holds — see `tokenGetter` in `@gravadigital/jiku/auth`.
 */
export class ServiceUser implements TokenSource {
  readonly #options: ServiceUserOptions;
  readonly #key: ServiceAccountKey;
  readonly #privateKey: KeyObject;
  #tokens: Tokens | undefined;
  #inFlight: Promise<string> | undefined;

  constructor(key: ServiceAccountKey, options: ServiceUserOptions) {
    if (!options.issuer) {
      throw new JikuError('jiku/auth: a service user needs an issuer');
    }
    if (!key.key || !key.keyId || !key.userId) {
      throw new JikuError(
        'jiku/auth: the service account key is missing key, keyId or userId; it does not look ' +
          'like a Zitadel machine user key',
      );
    }
    this.#key = key;
    this.#options = options;
    try {
      // createPrivateKey accepts both PEM encodings Zitadel has used: PKCS#1
      // ("RSA PRIVATE KEY") and PKCS#8 ("PRIVATE KEY").
      this.#privateKey = createPrivateKey(key.key);
    } catch (cause) {
      throw new JikuError(
        'jiku/auth: the `key` field of the service account is not a private key this runtime ' +
          'can read',
        { cause },
      );
    }
    if (this.#privateKey.asymmetricKeyType !== 'rsa') {
      throw new JikuError(
        `jiku/auth: the service account key is ${String(this.#privateKey.asymmetricKeyType)}, ` +
          'not RSA',
      );
    }
  }

  /** Builds a service user from the JSON key file Zitadel downloaded. */
  static async fromKeyFile(path: string, options: ServiceUserOptions): Promise<ServiceUser> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (cause) {
      throw new JikuError(`jiku/auth: reading the service account key ${path}`, { cause });
    }
    return ServiceUser.fromJson(raw, options);
  }

  /**
   * Builds a service user from the key file's CONTENTS, for callers that hold it in a secret
   * manager rather than on disk.
   */
  static fromJson(json: string | ServiceAccountKey, options: ServiceUserOptions): ServiceUser {
    if (typeof json !== 'string') {
      return new ServiceUser(json, options);
    }
    let parsed: ServiceAccountKey;
    try {
      parsed = JSON.parse(json) as ServiceAccountKey;
    } catch (cause) {
      throw new JikuError(
        'jiku/auth: parsing the service account key — this must be the JSON file Zitadel ' +
          'produced for a machine user, not a PEM on its own',
        { cause },
      );
    }
    return new ServiceUser(parsed, options);
  }

  /**
   * The machine user's id, which is also the `sub` of the tokens it mints.
   *
   * Available without a network call, straight from the key file.
   */
  get userId(): string {
    return this.#key.userId;
  }

  /** Returns a valid access token, minting a new one when needed. */
  async token(options?: TokenSourceOptions): Promise<string> {
    const current = this.#tokens;
    if (current && isFresh(expiryOf(current.access_token))) {
      return current.access_token;
    }
    // One mint at a time. A reconnect storm would otherwise become a burst of identical
    // assertions, and Zitadel rate-limits exactly that.
    this.#inFlight ??= this.#mint(options).finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #mint(options?: TokenSourceOptions): Promise<string> {
    const http: HttpOptions = { fetch: this.#options.fetch, signal: options?.signal };
    const discovery = await discover(this.#options.issuer, http);
    const tokens = await postForm(
      discovery.token_endpoint,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.#assertion(),
        scope: this.#scopes(),
      },
      http,
    );
    this.#tokens = tokens;
    return tokens.access_token;
  }

  currentToken(): string {
    return this.#tokens?.access_token ?? '';
  }

  /**
   * The machine user's id.
   *
   * It comes from the key file rather than from the token, so it needs no network call and works
   * before the first {@link token}.
   */
  subject(): Promise<string> {
    return Promise.resolve(this.#key.userId);
  }

  expiresAt(): Date | undefined {
    const token = this.#tokens?.access_token;
    return token ? expiryOf(token) : undefined;
  }

  /** The current token's claims, minting one if needed. */
  async claims(options?: TokenSourceOptions): Promise<Claims> {
    return decodeClaims(await this.token(options));
  }

  #scopes(): string {
    const scopes = this.#options.scopes?.length ? this.#options.scopes : ['openid', 'profile'];
    return [...scopes, ...projectScopes(this.#options.projectId ?? '')].join(' ');
  }

  /**
   * Builds and signs the JWT that stands in for a client secret.
   *
   * `iss` and `sub` are both the machine user's id: the key holder is asserting its own identity,
   * not acting on somebody else's behalf.
   */
  #assertion(): string {
    const now = Math.floor(Date.now() / 1000);
    const ttl = this.#options.assertionTtlMs ?? DEFAULT_ASSERTION_TTL_MS;
    const header = { alg: 'RS256', typ: 'JWT', kid: this.#key.keyId };
    const claims = {
      iss: this.#key.userId,
      sub: this.#key.userId,
      aud: this.#options.audience ?? this.#options.issuer.replace(/\/+$/, ''),
      iat: now,
      exp: now + Math.floor(ttl / 1000),
    };

    const encoder = new TextEncoder();
    const signingInput =
      `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.` +
      base64UrlEncode(encoder.encode(JSON.stringify(claims)));

    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(this.#privateKey);
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  }
}
