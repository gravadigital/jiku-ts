import { JikuError } from '../errors.ts';

/**
 * The claims of a Zitadel access token, DECODED AND NOT VERIFIED.
 *
 * The signature is NOT checked and cannot be trusted for any security decision. It is read for
 * three local, non-security purposes: to know the caller's own `sub` (for the subject and the
 * inbox prefix), to decide locally whether to refresh before expiry, and to tell a person which
 * roles they hold. Whoever validates the token is the auth-callout.
 */
export interface Claims {
  sub?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
  email?: string;
  name?: string;
  /**
   * The Zitadel project roles: role -> org id -> org domain.
   *
   * Zitadel emits these under TWO different claim keys, and which one you get depends on the
   * request rather than on anything you control:
   *
   * ```text
   * urn:zitadel:iam:org:project:roles          the roles of every project
   * urn:zitadel:iam:org:project:<id>:roles     the roles of ONE project
   * ```
   *
   * A person's token from the device flow tends to carry the first, a machine user's the second.
   * Both are merged here, because for the purpose this is read for — telling somebody which
   * roles they hold — the distinction is noise. The auth-callout reads the project-scoped one
   * when it is configured with a project id, precisely because a same-named role in another
   * project must not match a rule.
   *
   * Present only when the `urn:zitadel:iam:org:projects:roles` scope was requested. An empty
   * object here is the single most common reason a connection is refused.
   */
  roles: Record<string, Record<string, string>>;
  /** Every other claim, untouched. */
  raw: Record<string, unknown>;
}

/** Matches both shapes of Zitadel's project-roles claim. */
const ZITADEL_ROLE_CLAIM = /^urn:zitadel:iam:org:project:(?:[^:]+:)?roles$/;

/**
 * Decodes a JWT's claims without verifying anything.
 *
 * @throws {JikuError} when the token is not a three-segment JWT, which for a machine user almost
 * always means its Access Token Type is still the default `Bearer` rather than `JWT`.
 */
export function decodeClaims(token: string): Claims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JikuError(
      `jiku/auth: the access token is not a JWT (${parts.length} segments); a machine user ` +
        'needs Access Token Type = JWT in Zitadel for the auth-callout to read it',
    );
  }

  let json: string;
  try {
    json = new TextDecoder().decode(base64UrlDecode(parts[1] as string));
  } catch (cause) {
    throw new JikuError('jiku/auth: decoding the token payload', { cause });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch (cause) {
    throw new JikuError('jiku/auth: parsing the token claims', { cause });
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new JikuError('jiku/auth: the token payload is not a JSON object');
  }

  const raw = payload as Record<string, unknown>;
  const roles: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ZITADEL_ROLE_CLAIM.test(key) || typeof value !== 'object' || value === null) {
      continue;
    }
    for (const [role, orgs] of Object.entries(value as Record<string, unknown>)) {
      if (typeof orgs !== 'object' || orgs === null) {
        continue;
      }
      roles[role] = { ...roles[role], ...(orgs as Record<string, string>) };
    }
  }

  return {
    ...pickString(raw, 'sub'),
    ...pickNumber(raw, 'exp'),
    ...pickNumber(raw, 'iat'),
    ...pickString(raw, 'iss'),
    ...pickString(raw, 'email'),
    ...pickString(raw, 'name'),
    ...(raw['aud'] === undefined ? {} : { aud: raw['aud'] as string | string[] }),
    roles,
    raw,
  };
}

/** The role names in a set of claims, sorted. */
export function roleNames(claims: Claims): string[] {
  return Object.keys(claims.roles).sort();
}

/** When a token stops being accepted, or `undefined` when it carries no `exp`. */
export function expiryOf(token: string): Date | undefined {
  try {
    const exp = decodeClaims(token).exp;
    return typeof exp === 'number' ? new Date(exp * 1000) : undefined;
  } catch {
    // A token this library cannot read is not necessarily a token the callout cannot read —
    // an opaque token is still worth presenting. Treating it as "expiry unknown" lets the
    // caller find out from the server rather than from a guess made here.
    return undefined;
  }
}

function pickString(raw: Record<string, unknown>, key: string): Record<string, string> {
  const value = raw[key];
  return typeof value === 'string' ? { [key]: value } : {};
}

function pickNumber(raw: Record<string, unknown>, key: string): Record<string, number> {
  const value = raw[key];
  return typeof value === 'number' ? { [key]: value } : {};
}

/**
 * Decodes base64url.
 *
 * `atob` is the only base64 decoder available in every runtime this package targets, and it
 * speaks standard base64 — so the URL alphabet and the missing padding are restored first.
 */
export function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Encodes bytes as base64url without padding, which is what a JWT's segments are. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
