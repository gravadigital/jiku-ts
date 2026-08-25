import type { TokenSource } from './auth/types.ts';
import { DEFAULT_INSTANCE, DEFAULT_TIMEOUT_MS } from './client.ts';
import { JikuInvalidRequest } from './errors.ts';

/** The Zitadel instance used when none is configured. */
export const DEFAULT_ISSUER = 'https://id.grava.io';

/** The NATS URL used when none is configured. */
export const DEFAULT_SERVERS = 'nats://localhost:4222';

/**
 * Everything needed to open a connection.
 *
 * Build it in code, or load the shared config file and environment with `loadConfig()` from
 * `@gravadigital/jiku/node`.
 */
export interface ConnectOptions {
  /**
   * NATS URLs. A comma-separated string or an array.
   *
   * The scheme picks the transport: `nats://` and `tls://` open a TCP connection, which only the
   * Node entry point can do; `ws://` and `wss://` open a WebSocket, which works everywhere.
   */
  servers?: string | string[] | undefined;

  /**
   * The deployment token of every subject: `dev` or `prod`. Defaults to `dev`.
   *
   * Getting it wrong produces a request nobody is subscribed to, and the symptom is a timeout
   * rather than an error.
   */
  instance?: string | undefined;

  /**
   * The sentinel NATS creds, as the CONTENTS of the file.
   *
   * It grants no permissions by itself — the file's own JWT denies pub and sub on `>` — and
   * exists only to let the connection reach the auth-callout, which is what mints real
   * permissions from the Zitadel token. That is what makes it safe to ship in a browser bundle,
   * and it is the only credential in this system that is.
   *
   * Pass `null` to say this bus needs no creds at all. That is NOT how you talk to Jiku — the
   * deployment runs NATS in operator mode and the handshake will be refused — but it is how you
   * point this client at a plain NATS in a test. It is `null` rather than an empty string on
   * purpose: an unset environment variable produces `undefined`, so "no creds" can only ever be
   * something you wrote deliberately.
   */
  creds?: string | Uint8Array | null | undefined;

  /**
   * A path to the sentinel creds file, read at connect time.
   *
   * Node only. The browser entry point throws on this, because it cannot read files — pass
   * {@link creds} with the contents instead.
   */
  credsFile?: string | undefined;

  /** The token source. Required, and the only thing that decides what you may do. */
  auth: TokenSource;

  /** The per-request bus timeout in milliseconds. See `DEFAULT_TIMEOUT_MS` for why 15s. */
  timeoutMs?: number | undefined;

  /** Identifies this client in `nats server report connections`. Defaults to `jiku-ts`. */
  name?: string | undefined;

  /**
   * Overrides the caller identity used in subjects. LEAVE IT UNSET.
   *
   * It is derived from the token's `sub`, and the callout only authorises publishing under one's
   * own id, so a value that disagrees with the token produces an authorization violation rather
   * than access to somebody else's namespace. It exists for diagnostics.
   */
  userId?: string | undefined;

  /** Called when a background token refresh fails. Defaults to a warning on the console. */
  onTokenError?: ((error: unknown) => void) | undefined;

  /**
   * Extra options passed straight to the NATS client.
   *
   * `servers`, `authenticator`, `inboxPrefix` and `name` are set by this library and cannot be
   * overridden — the first three are what make a connection to this bus work at all.
   */
  nats?: Record<string, unknown> | undefined;
}

/** A {@link ConnectOptions} with the defaults filled in. */
export interface ResolvedConnectOptions extends ConnectOptions {
  servers: string[];
  instance: string;
  timeoutMs: number;
  name: string;
}

/** The environment variables, which a container gets configured with. */
export const ENV = {
  servers: 'JIKU_SERVERS',
  instance: 'JIKU_INSTANCE',
  creds: 'JIKU_CREDS',
  timeout: 'JIKU_TIMEOUT',
  issuer: 'JIKU_ISSUER',
  clientId: 'JIKU_CLIENT_ID',
  projectId: 'JIKU_PROJECT_ID',
  keyFile: 'JIKU_KEY_FILE',
} as const;

/** Splits and cleans a `servers` value in either accepted shape. */
export function parseServers(servers: string | string[] | undefined): string[] {
  const raw = Array.isArray(servers) ? servers : (servers ?? '').split(',');
  return raw.map((server) => server.trim()).filter((server) => server !== '');
}

/**
 * Applies the defaults and reports what is missing, naming the option and the environment
 * variable that supplies it.
 *
 * "invalid config" with no pointer to the fix is the least useful error a tool can give.
 */
export function resolveOptions(options: ConnectOptions): ResolvedConnectOptions {
  const servers = parseServers(options.servers);
  const missing: string[] = [];

  // Viewed as partial on purpose. The type says `auth` is required; a JavaScript caller, or a
  // config object assembled at runtime, can still arrive without it — and "cannot read
  // properties of undefined" three frames down is not an error message.
  const given = options as Partial<ConnectOptions>;

  if (!given.auth) {
    missing.push('auth — a token source; see @gravadigital/jiku/auth');
  }
  // `null` is an explicit "this bus needs none"; `undefined` is a forgotten setting.
  if (given.creds === undefined && !given.credsFile) {
    missing.push(
      `creds or credsFile (${ENV.creds}) — the sentinel creds file; ask whoever runs the bus ` +
        'for it. Pass `creds: null` if you are pointing this at a NATS that needs none',
    );
  }
  if (missing.length > 0) {
    throw new JikuInvalidRequest(`jiku: incomplete config: ${missing.join('; ')}`);
  }

  return {
    ...options,
    servers: servers.length > 0 ? servers : [DEFAULT_SERVERS],
    instance: options.instance || DEFAULT_INSTANCE,
    timeoutMs: options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
    name: options.name || 'jiku-ts',
  };
}

/**
 * Reports whether every server URL is a WebSocket URL.
 *
 * The two transports cannot be mixed in one connection, so a list that names both is a
 * configuration mistake worth catching before the first handshake.
 */
export function transportOf(servers: string[]): 'ws' | 'tcp' {
  const ws = servers.filter((server) => /^wss?:\/\//i.test(server));
  if (ws.length === 0) {
    return 'tcp';
  }
  if (ws.length === servers.length) {
    return 'ws';
  }
  throw new JikuInvalidRequest(
    'jiku: the servers list mixes WebSocket and TCP URLs, which one connection cannot do. ' +
      `Use one or the other: ${servers.join(', ')}`,
  );
}
