import { JikuError } from '../errors.ts';

/**
 * The subset of the OpenID provider metadata this package uses.
 *
 * The endpoints are READ FROM THE WELL-KNOWN, never hardcoded, so the same code works against
 * any Zitadel instance and keeps working if one moves a path.
 */
export interface Discovery {
  issuer?: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  userinfo_endpoint?: string;
}

/** What an OIDC token endpoint answered, plus when we learned it. */
export interface Tokens {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  /**
   * Set by this package, not by the provider, so expiry survives being written to a file and
   * read back tomorrow. Without it a stored `expires_in` is meaningless.
   *
   * An RFC 3339 timestamp, NOT a number of milliseconds. The token file at
   * `~/.config/jiku/tokens-<instance>.json` is a shared location on a machine, and a timestamp
   * string is what every client there can read; a language with a stricter date type than
   * JavaScript's will not accept a number back.
   *
   * Nothing here depends on it: expiry is read from the token's own `exp` claim, and this is the
   * fallback for a token that carries none.
   */
  obtained_at?: string;
}

/**
 * An OAuth error response, which carries the field that says what to do next.
 *
 * The message includes a hint for the codes that actually happen against Zitadel; every one of
 * them was a line in somebody's troubleshooting notes first.
 */
export class OAuthError extends JikuError {
  readonly code: string;
  readonly description: string | undefined;
  readonly status: number | undefined;

  constructor(code: string, description?: string, status?: number) {
    let message = `zitadel: ${code}`;
    if (description) {
      message += `: ${description}`;
    }
    const hint = oauthHint(code);
    if (hint) {
      message += `\n  hint: ${hint}`;
    }
    super(message);
    this.code = code;
    this.description = description;
    this.status = status;
  }
}

/** Maps the OAuth error codes that actually happen here to their real cause. */
function oauthHint(code: string): string | undefined {
  switch (code) {
    case 'unauthorized_client':
      return (
        'the app does not have the grant type enabled, or the client id is wrong. For the ' +
        'device flow, enable "Device Code" on a Native app in Zitadel.'
      );
    case 'expired_token':
      return 'the device code expired (300s). Run the login again.';
    case 'access_denied':
      return 'the authorization was rejected in the browser.';
    case 'invalid_client':
      return (
        'the client id, or the service account key, was not accepted. Check that the key ' +
        'still exists on the machine user and has not been revoked.'
      );
    case 'invalid_grant':
      return (
        'the assertion was rejected. The usual causes are a clock skew of more than a minute, ' +
        'a wrong audience, or a key that was deleted in Zitadel.'
      );
    case 'invalid_scope':
      return (
        'a requested scope is not allowed for this client. Check the project id in the ' +
        'reserved zitadel scopes.'
      );
    default:
      return undefined;
  }
}

/** How long an identity-provider request may take before it is abandoned. */
const HTTP_TIMEOUT_MS = 30_000;

/** One megabyte, the cap on a response body this package will read. */
const MAX_BODY_BYTES = 1 << 20;

const discoveries = new Map<string, Discovery>();

/** Options shared by the functions that talk to the identity provider. */
export interface HttpOptions {
  signal?: AbortSignal | undefined;
  /**
   * Replaces the `fetch` used for identity-provider calls.
   *
   * It exists for tests, for a proxy, and for runtimes that want their own instrumentation. It
   * is never used for the bus, which does not speak HTTP.
   */
  fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Fetches (and memoises) the provider metadata for an issuer.
 *
 * The cache is process-wide and has no expiry: a discovery document that changed under a running
 * process is a deployment event, not a runtime condition.
 */
export async function discover(issuer: string, options: HttpOptions = {}): Promise<Discovery> {
  const normalized = issuer.replace(/\/+$/, '');
  if (normalized === '') {
    throw new JikuError('jiku/auth: no issuer configured');
  }
  const cached = discoveries.get(normalized);
  if (cached) {
    return cached;
  }

  const url = `${normalized}/.well-known/openid-configuration`;
  const response = await request(
    url,
    { method: 'GET', headers: { accept: 'application/json' } },
    options,
  );
  const body = await readBody(response);

  if (!response.ok) {
    throw new JikuError(
      `jiku/auth: discovery of ${normalized} answered ${response.status} — is that the right ` +
        'issuer URL?',
    );
  }

  let parsed: Discovery;
  try {
    parsed = JSON.parse(body) as Discovery;
  } catch (cause) {
    throw new JikuError(`jiku/auth: parsing discovery of ${normalized}`, { cause });
  }
  if (!parsed.token_endpoint) {
    throw new JikuError(`jiku/auth: ${normalized} publishes no token_endpoint`);
  }

  discoveries.set(normalized, parsed);
  return parsed;
}

/** Forgets every memoised discovery document. Exists for tests. */
export function clearDiscoveryCache(): void {
  discoveries.clear();
}

/**
 * Sends a form-urlencoded request to a token endpoint and decodes either {@link Tokens} or an
 * {@link OAuthError}, which is the one shape both flows share.
 */
export async function postForm(
  endpoint: string,
  form: Record<string, string>,
  options: HttpOptions = {},
): Promise<Tokens> {
  const response = await request(
    endpoint,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    },
    options,
  );
  const body = await readBody(response);

  if (!response.ok) {
    throw toOAuthError(body, response.status);
  }

  let tokens: Tokens;
  try {
    tokens = JSON.parse(body) as Tokens;
  } catch (cause) {
    throw new JikuError('jiku/auth: parsing the token response', { cause });
  }
  if (!tokens.access_token) {
    throw new JikuError('jiku/auth: the token endpoint returned no access_token');
  }
  tokens.obtained_at = new Date().toISOString();
  return tokens;
}

/**
 * Turns a non-2xx token-endpoint body into the most specific error it supports: an
 * {@link OAuthError} when the body is an OAuth error object, a plain one otherwise.
 */
export function toOAuthError(body: string, status: number): JikuError {
  try {
    const parsed: unknown = JSON.parse(body);
    const oauth = parsed as { error?: string; error_description?: string } | null;
    if (oauth && typeof oauth.error === 'string' && oauth.error !== '') {
      return new OAuthError(oauth.error, oauth.error_description, status);
    }
  } catch {
    // Not JSON. The raw body is more useful than a parse error about it.
  }
  return new JikuError(`jiku/auth: token endpoint answered ${status}: ${body.trim()}`);
}

/** Fetches a userinfo endpoint with a bearer token, returning its claims as plain data. */
export async function fetchUserinfo(
  endpoint: string,
  accessToken: string,
  options: HttpOptions = {},
): Promise<Record<string, unknown>> {
  const response = await request(
    endpoint,
    {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
    },
    options,
  );
  const body = await readBody(response);
  if (!response.ok) {
    throw new JikuError(`jiku/auth: userinfo answered ${response.status}: ${body.trim()}`);
  }
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch (cause) {
    throw new JikuError('jiku/auth: parsing the userinfo response', { cause });
  }
}

async function request(url: string, init: RequestInit, options: HttpOptions): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new JikuError(
      'jiku/auth: this runtime has no global fetch. Pass one as `fetch` in the auth options.',
    );
  }

  // A timeout of our own, combined with the caller's signal. AbortSignal.any is available on
  // every runtime this package supports; the timeout alone would ignore the caller's cancel,
  // and the caller's alone would let a hung provider hang the connect forever.
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  try {
    return await doFetch(url, { ...init, signal });
  } catch (cause) {
    if (timeout.aborted) {
      throw new JikuError(`jiku/auth: ${url} did not answer within ${HTTP_TIMEOUT_MS}ms`, {
        cause,
      });
    }
    if (options.signal?.aborted) {
      throw cause;
    }
    throw new JikuError(`jiku/auth: reaching ${url}`, { cause });
  }
}

/**
 * Reads a response body, refusing to buffer more than {@link MAX_BODY_BYTES}.
 *
 * An identity provider that answers a gigabyte is either broken or not an identity provider, and
 * either way reading it all would be the client's problem, not the server's.
 */
async function readBody(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    return '';
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        throw new JikuError(
          `jiku/auth: ${response.url} answered more than ${MAX_BODY_BYTES} bytes; refusing to ` +
            'buffer it',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * The two reserved Zitadel scopes that make a token usable on this bus.
 *
 * ```text
 * urn:zitadel:iam:org:projects:roles          puts the roles in the token
 * urn:zitadel:iam:org:project:id:<id>:aud     puts the project in the `aud` claim
 * ```
 *
 * The callout reads the ROLE to choose a permission template, so a token without the roles claim
 * connects to nothing. This is the field people forget.
 */
export function projectScopes(projectId: string): string[] {
  return projectId
    ? ['urn:zitadel:iam:org:projects:roles', `urn:zitadel:iam:org:project:id:${projectId}:aud`]
    : [];
}
