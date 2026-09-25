import { JikuError } from '../errors.ts';
import { decodeClaims, expiryOf } from './claims.ts';
import {
  discover,
  OAuthError,
  postForm,
  projectScopes,
  toOAuthError,
  type Discovery,
  type HttpOptions,
  type Tokens,
} from './oidc.ts';
import { isFresh, type TokenSource, type TokenSourceOptions } from './types.ts';

/**
 * Persists tokens between runs of a program.
 *
 * It exists for the device flow, where losing the tokens means going back to the browser. A
 * service user needs none: its key mints a token whenever one is wanted.
 *
 * `FileStore` in `@gravadigital/jiku/node` is the implementation for a command-line tool. There
 * is deliberately NO browser store in this package: a refresh token in `localStorage` is
 * readable by every script on the origin, and a browser application that has already
 * authenticated its user should hand this library the access token it holds — see
 * `tokenGetter`.
 */
export interface Store {
  load(): Promise<Tokens | undefined>;
  save(tokens: Tokens): Promise<void>;
  /** Describes where the tokens live, for diagnostics. */
  location(): string;
}

/** What the device authorization endpoint answered. */
export interface DeviceAuth {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/**
 * Configures the device authorization grant (RFC 8628) — the flow for a PERSON at a terminal.
 *
 * It suits a human because the browser does the authenticating: you get a short code, approve it
 * once, and the terminal receives the tokens. It is the wrong tool for unattended work (cron,
 * CI, a long-running service) because somebody has to click. Use `ServiceUser` from
 * `@gravadigital/jiku/node` there.
 */
export interface DeviceFlowOptions extends HttpOptions {
  /** The Zitadel instance, e.g. `https://id.example.com`. */
  issuer: string;
  /**
   * Client id of a NATIVE app in Zitadel with the "Device Code" grant type enabled. Without that
   * grant the token endpoint answers `unauthorized_client`. It also needs "Refresh Token":
   * without it Zitadel ignores `offline_access` silently and every expiry is a login.
   */
  clientId: string;
  /**
   * The Zitadel project id.
   *
   * The callout reads the ROLE to choose a permission template, so a token without the roles
   * claim connects to nothing. This is the field people forget.
   */
  projectId?: string | undefined;
  /**
   * Scopes to request. Defaults to `openid`, `profile`, `email` and `offline_access`.
   *
   * `offline_access` is necessary for a refresh token and not sufficient: Zitadel issues one
   * only when the app also has the "Refresh Token" grant, and otherwise drops the scope without
   * an error. Without a refresh token every expiry means another trip to the browser.
   */
  scopes?: string[] | undefined;
  /**
   * Persists the tokens between runs. Without one the flow is interactive on every process
   * start, which is almost never what you want.
   */
  store?: Store | undefined;
  /**
   * Shows the verification URL and code to the person.
   *
   * Defaults to writing to stderr where a console exists. A GUI should replace it; there is no
   * attempt to open a browser from this package, because a library that spawns processes is a
   * library that surprises somebody.
   */
  prompt?: ((auth: DeviceAuth) => void | Promise<void>) | undefined;
}

/**
 * Thrown when no stored token is usable and the flow needs a browser.
 *
 * Callers that must not block — a service, a request handler — should treat it as fatal and tell
 * the operator to log in. {@link DeviceFlow.token} NEVER starts an interactive flow on its own:
 * a call that silently blocks on a human is the kind of surprise that takes a production service
 * down at 3am.
 */
export class LoginRequired extends JikuError {
  constructor(message = 'jiku/auth: login required') {
    super(message);
  }
}

/**
 * A {@link TokenSource} backed by the device authorization grant.
 *
 * It refreshes silently while a refresh token is usable and only asks for a browser when it
 * genuinely has to — which for the ~20h tokens Zitadel issues here is rarely.
 */
export class DeviceFlow implements TokenSource {
  readonly #options: DeviceFlowOptions;
  /** The requested scopes with the defaults applied; never empty. */
  readonly #baseScopes: readonly string[];
  #tokens: Tokens | undefined;
  #loaded = false;
  #inFlight: Promise<string> | undefined;

  constructor(options: DeviceFlowOptions) {
    if (!options.issuer) {
      throw new JikuError('jiku/auth: the device flow needs an issuer');
    }
    if (!options.clientId) {
      throw new JikuError('jiku/auth: the device flow needs a clientId');
    }
    this.#options = options;
    this.#baseScopes =
      options.scopes && options.scopes.length > 0
        ? options.scopes
        : ['openid', 'profile', 'email', 'offline_access'];
  }

  /**
   * Assembles the requested scopes plus the two reserved Zitadel ones.
   *
   * They are built here rather than being asked of the caller so the project id appears exactly
   * once and in the right shape. A refresh must request a SUBSET of the original scopes, and
   * omitting them there can return a renewed token WITHOUT the roles claim — which would connect
   * to nothing. So the same set is used for both.
   */
  #scopes(): string {
    return [...this.#baseScopes, ...projectScopes(this.#options.projectId ?? '')].join(' ');
  }

  #http(options?: TokenSourceOptions): HttpOptions {
    return { fetch: this.#options.fetch, signal: options?.signal };
  }

  /**
   * Returns a valid access token, refreshing or loading from the store as needed.
   *
   * @throws {LoginRequired} when a browser is needed. Call {@link login} for that.
   */
  async token(options?: TokenSourceOptions): Promise<string> {
    this.#inFlight ??= this.#resolveToken(options).finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #resolveToken(options?: TokenSourceOptions): Promise<string> {
    await this.#load();

    const current = this.#tokens;
    if (current && isFresh(expiryOf(current.access_token))) {
      return current.access_token;
    }
    if (current?.refresh_token) {
      await this.#refresh(current.refresh_token, options);
      return (this.#tokens as Tokens).access_token;
    }
    if (current?.access_token) {
      // An expired session with no refresh token is not a session that ran its course: it is one
      // that could never be renewed, and logging in again only restarts the clock.
      throw new LoginRequired(
        'jiku/auth: login required: the stored token expired and there is no refresh token to ' +
          `renew it\n  hint: ${NO_REFRESH_TOKEN_HINT}`,
      );
    }
    throw new LoginRequired(
      'jiku/auth: login required: no stored token is usable and none can be refreshed',
    );
  }

  currentToken(): string {
    return this.#tokens?.access_token ?? '';
  }

  async subject(options?: TokenSourceOptions): Promise<string> {
    const sub = decodeClaims(await this.token(options)).sub;
    if (!sub) {
      throw new JikuError('jiku/auth: the access token carries no `sub` claim');
    }
    return sub;
  }

  expiresAt(): Date | undefined {
    const token = this.#tokens?.access_token;
    return token ? expiryOf(token) : undefined;
  }

  /** The tokens currently held, for diagnostics. */
  tokens(): Tokens | undefined {
    return this.#tokens ? { ...this.#tokens } : undefined;
  }

  /**
   * Runs the interactive flow: it shows a code, waits for the authorization, and stores the
   * tokens.
   *
   * This is the one method that blocks on a human, and it is separate from {@link token} for
   * exactly that reason.
   *
   * Check `refresh_token` on what it returns. When it is absent the login worked but will not
   * survive the token's expiry: the Native app lacks the "Refresh Token" grant, and Zitadel said
   * nothing. This method does not warn on its own — how to tell the person is the caller's call.
   */
  async login(options?: TokenSourceOptions): Promise<Tokens> {
    const http = this.#http(options);
    const discovery = await discover(this.#options.issuer, http);
    if (!discovery.device_authorization_endpoint) {
      throw new JikuError(
        `jiku/auth: ${this.#options.issuer} publishes no device_authorization_endpoint, so the ` +
          'device flow is not available on this instance',
      );
    }

    const auth = await this.#authorize(discovery, http);
    const prompt = this.#options.prompt ?? defaultPrompt;
    await prompt(auth);

    const tokens = await this.#poll(discovery, auth, options);
    this.#tokens = tokens;
    this.#loaded = true;
    if (this.#options.store) {
      try {
        await this.#options.store.save(tokens);
      } catch (cause) {
        throw new JikuError('jiku/auth: the login succeeded but storing it failed', { cause });
      }
    }
    return tokens;
  }

  /** The POST that starts the flow and yields the user code. */
  async #authorize(discovery: Discovery, http: HttpOptions): Promise<DeviceAuth> {
    const doFetch = http.fetch ?? globalThis.fetch;
    const response = await doFetch(discovery.device_authorization_endpoint as string, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.#options.clientId,
        scope: this.#scopes(),
      }).toString(),
      ...(http.signal ? { signal: http.signal } : {}),
    });
    const body = await response.text();

    if (!response.ok) {
      throw toOAuthError(body, response.status);
    }

    let auth: DeviceAuth;
    try {
      auth = JSON.parse(body) as DeviceAuth;
    } catch (cause) {
      throw new JikuError('jiku/auth: parsing the device authorization', { cause });
    }
    if (!(auth.interval > 0)) {
      auth.interval = 5;
    }
    if (!(auth.expires_in > 0)) {
      auth.expires_in = 300;
    }
    return auth;
  }

  /**
   * Waits for the person to authorise, honouring the two codes RFC 8628 defines for it:
   * `authorization_pending` means keep going, `slow_down` means back off permanently.
   */
  async #poll(
    discovery: Discovery,
    auth: DeviceAuth,
    options?: TokenSourceOptions,
  ): Promise<Tokens> {
    let interval = auth.interval * 1000;
    const deadline = Date.now() + auth.expires_in * 1000;

    for (;;) {
      await sleep(interval, options?.signal);
      if (Date.now() > deadline) {
        throw new JikuError(
          `jiku/auth: the device code expired after ${auth.expires_in}s without being authorized`,
        );
      }

      try {
        return await postForm(
          discovery.token_endpoint,
          {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: auth.device_code,
            client_id: this.#options.clientId,
          },
          this.#http(options),
        );
      } catch (error) {
        if (!(error instanceof OAuthError)) {
          throw error;
        }
        if (error.code === 'authorization_pending') {
          continue;
        }
        if (error.code === 'slow_down') {
          interval += 5000;
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Renews the access token.
   *
   * Zitadel ROTATES the refresh token on every use, so the new one is kept; when a response
   * carries none, the previous one is preserved rather than dropped.
   */
  async #refresh(refreshToken: string, options?: TokenSourceOptions): Promise<void> {
    const http = this.#http(options);
    const discovery = await discover(this.#options.issuer, http);
    let tokens: Tokens;
    try {
      tokens = await postForm(
        discovery.token_endpoint,
        {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.#options.clientId,
          scope: this.#scopes(),
        },
        http,
      );
    } catch (error) {
      if (
        error instanceof OAuthError &&
        (error.code === 'invalid_grant' || error.code === 'invalid_token')
      ) {
        throw new LoginRequired(
          `jiku/auth: login required: the refresh token was rejected (${error.code})`,
        );
      }
      throw error;
    }
    // Zitadel ROTATES the refresh token on every use. When a response carries none, the
    // previous one is preserved rather than dropped.
    tokens.refresh_token ??= refreshToken;
    this.#tokens = tokens;
    if (this.#options.store) {
      await this.#options.store.save(tokens);
    }
  }

  /**
   * Reads the store once, lazily. A store that holds nothing is not an error: it just means
   * nobody has logged in yet.
   */
  async #load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    if (!this.#options.store) {
      return;
    }
    this.#tokens = await this.#options.store.load();
  }
}

/**
 * Explains an expired session that had no refresh token. `offline_access` is requested by default,
 * and Zitadel ignores it silently unless the app has the Refresh Token grant — so the symptom is a
 * login a day, with nothing pointing at the app's configuration. The wording is not an API.
 */
const NO_REFRESH_TOKEN_HINT =
  'Zitadel issued no refresh token, so every expiry needs a new login. Enable the "Refresh ' +
  'Token" grant type on the Native app in Zitadel, next to "Device Code", then log in once more.';

/**
 * Writes the verification URL and code to stderr.
 *
 * It deliberately does NOT open a browser. Spawning a process is not something a library should
 * do without being asked, and in a container or over SSH it fails in a way that looks like the
 * flow itself broke.
 */
function defaultPrompt(auth: DeviceAuth): void {
  const url = auth.verification_uri_complete || auth.verification_uri;
  const lines = [
    '',
    '  To authorize this client, open:',
    `      ${url}`,
    '',
    `  and enter the code:  ${auth.user_code}`,
    '',
    `  Waiting for authorization (expires in ${auth.expires_in}s)...`,
    '',
  ];
  console.error(lines.join('\n'));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
