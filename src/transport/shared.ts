import {
  AuthorizationError,
  credsAuthenticator,
  tokenAuthenticator,
  type Authenticator,
  type ConnectionOptions,
  type NatsConnection,
} from '@nats-io/nats-core';

import { Client } from '../client.ts';
import { ENV, resolveOptions, type ConnectOptions } from '../config.ts';
import { JikuError } from '../errors.ts';
import { inboxPrefix } from '../subject.ts';

/** How a transport opens the underlying connection. */
export type Opener = (options: ConnectionOptions) => Promise<NatsConnection>;

/**
 * The shared half of `connect()`: everything that is identical whether the socket is TCP or a
 * WebSocket.
 *
 * It does four things a hand-rolled NATS connect does not, and each one is a failure mode
 * somebody has already spent an afternoon on:
 *
 *  1. It sets the inbox prefix to `_INBOX.<hash(sub)>`. Without it every request times out with
 *     no error anywhere the caller can see. See `inboxPrefix()`.
 *  2. It takes the token from the {@link TokenSource} on every (re)connect via
 *     `tokenAuthenticator`, so a reconnect after the token expired re-authenticates instead of
 *     being refused.
 *  3. It derives the caller identity from the token's `sub`, so no subject has to be written by
 *     hand and none can disagree with the credential presenting it.
 *  4. It asks for a token BEFORE connecting, so a broken identity configuration fails with what
 *     is actually wrong instead of with a NATS authorization violation that names neither
 *     credential.
 */
export async function connectWith(
  open: Opener,
  credsBytes: Uint8Array | undefined,
  options: ConnectOptions,
): Promise<Client> {
  const resolved = resolveOptions(options);
  const auth = resolved.auth;

  // Fail before connecting if no token can be had. A NATS authorization violation says nothing
  // about which of the two credentials was the problem.
  let userId = resolved.userId;
  try {
    await auth.token();
    userId ||= await auth.subject();
  } catch (cause) {
    throw new JikuError('jiku: obtaining an access token', { cause });
  }
  if (!userId) {
    throw new JikuError('jiku: the token carries no `sub`, so there is no caller identity');
  }

  const prefix = await inboxPrefix(userId);

  const authenticators: Authenticator[] = [];
  if (credsBytes) {
    authenticators.push(credsAuthenticator(credsBytes));
  }
  // tokenAuthenticator with a FUNCTION, not a string: it is called again on every reconnect, so
  // a long-lived connection that drops after the token expired comes back with a fresh one.
  authenticators.push(tokenAuthenticator(() => auth.currentToken()));

  const connectionOptions: ConnectionOptions = {
    // The caller's extras go first so the four settings below always win. Those four are what
    // make a connection to THIS bus work; letting them be overridden would turn a supported
    // configuration into an unsupported one silently.
    ...resolved.nats,
    servers: resolved.servers,
    name: resolved.name,
    inboxPrefix: prefix,
    authenticator: authenticators,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    reconnectJitter: 200,
    reconnectJitterTLS: 1000,
    timeout: 10_000,
  };

  let nc: NatsConnection;
  try {
    nc = await open(connectionOptions);
  } catch (cause) {
    throw connectError(resolved.servers, cause);
  }

  return Client.create(
    nc,
    {
      instance: resolved.instance,
      userId,
      timeoutMs: resolved.timeoutMs,
      auth,
      onTokenError: resolved.onTokenError,
    },
    prefix,
  );
}

/**
 * Translates the NATS handshake failures whose message does not say what actually went wrong on
 * this bus.
 */
export function connectError(servers: string[], cause: unknown): JikuError {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (cause instanceof AuthorizationError || /Authorization Violation/i.test(message)) {
    return new JikuError(
      'jiku: the bus refused the credentials\n' +
        '  The sentinel creds got you to the auth-callout; what it rejected is the Zitadel ' +
        'token. The usual causes:\n' +
        `    - the token carries no project ROLES claim (set projectId / ${ENV.projectId}), so ` +
        'no rule matched\n' +
        '    - the role it carries has no rule in the callout, so the connection is refused by ' +
        'design\n' +
        '    - a machine user whose Access Token Type is not JWT\n' +
        '    - the access token expired between being minted and being validated',
      { cause },
    );
  }

  if (/no servers available|CONNECTION_REFUSED|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return new JikuError(
      `jiku: no NATS server answered at ${servers.join(', ')}\n` +
        `  Check the URL and that you can reach it (set ${ENV.servers}). A browser needs the ` +
        "server's WebSocket listener (wss://), not the TCP port.",
      { cause },
    );
  }

  return new JikuError(`jiku: connecting to ${servers.join(', ')}`, { cause });
}
