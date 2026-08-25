import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  base64UrlDecode,
  base64UrlEncode,
  decodeClaims,
  expiryOf,
  roleNames,
} from '../src/auth/claims.ts';
import { OAuthError, projectScopes, toOAuthError } from '../src/auth/oidc.ts';
import { staticToken, tokenGetter } from '../src/auth/static.ts';
import { isFresh, REFRESH_SKEW_MS } from '../src/auth/types.ts';
import { JikuError } from '../src/errors.ts';

const b64 = (value: unknown): string =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
const jwt = (claims: Record<string, unknown>): string =>
  `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`;
const soon = (): number => Math.floor(Date.now() / 1000) + 3600;

describe('base64url', () => {
  test('round-trips bytes without padding', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'ñandú ✅']) {
      const bytes = new TextEncoder().encode(text);
      const encoded = base64UrlEncode(bytes);
      assert.ok(!encoded.includes('='), encoded);
      assert.ok(!encoded.includes('+') && !encoded.includes('/'), encoded);
      assert.deepEqual(base64UrlDecode(encoded), bytes, text);
    }
  });
});

describe('decodeClaims', () => {
  test('reads the standard claims', () => {
    const claims = decodeClaims(jwt({ sub: '42', exp: 100, iss: 'https://id', name: 'A' }));
    assert.equal(claims.sub, '42');
    assert.equal(claims.exp, 100);
    assert.equal(claims.name, 'A');
  });

  test('merges BOTH shapes of the Zitadel roles claim', () => {
    // A person's token carries the project-wide key, a machine user's the project-scoped one.
    // Which you get depends on the request rather than on anything you control.
    const claims = decodeClaims(
      jwt({
        sub: '1',
        'urn:zitadel:iam:org:project:roles': { admin: { org1: 'a.example' } },
        'urn:zitadel:iam:org:project:275672248377933829:roles': { user: { org1: 'a.example' } },
      }),
    );
    assert.deepEqual(roleNames(claims), ['admin', 'user']);
  });

  test('leaves roles empty when the reserved scopes were not requested', () => {
    // This is the single most common reason a connection is refused, so it must be visible.
    assert.deepEqual(roleNames(decodeClaims(jwt({ sub: '1' }))), []);
  });

  test('keeps every other claim in `raw`', () => {
    assert.equal(decodeClaims(jwt({ sub: '1', custom: 7 })).raw['custom'], 7);
  });

  test('says what an opaque token really is', () => {
    // A machine user left on the default Bearer token type is the most common misconfiguration
    // of the service-user flow, and "not a JWT" alone would not point at it.
    assert.throws(
      () => decodeClaims('opaque-token-here'),
      (error: unknown) => {
        assert.ok(error instanceof JikuError);
        assert.match(error.message, /Access Token Type = JWT/);
        return true;
      },
    );
  });
});

describe('expiryOf', () => {
  test('reads the exp claim', () => {
    assert.equal(expiryOf(jwt({ exp: 1_800_000_000 }))?.getTime(), 1_800_000_000_000);
  });

  test('is undefined rather than throwing for a token it cannot read', () => {
    // An opaque token is still worth presenting; the server decides, not a guess made here.
    assert.equal(expiryOf('opaque'), undefined);
    assert.equal(expiryOf(jwt({ sub: '1' })), undefined);
  });
});

describe('isFresh', () => {
  test('treats a token as expired a minute before it really is', () => {
    const now = Date.now();
    assert.equal(isFresh(new Date(now + REFRESH_SKEW_MS + 1000), now), true);
    assert.equal(isFresh(new Date(now + REFRESH_SKEW_MS - 1000), now), false);
    assert.equal(isFresh(undefined, now), false);
  });
});

describe('staticToken', () => {
  test('takes the subject from the token', () => {
    const source = staticToken(jwt({ sub: '275649063808925701', exp: soon() }));
    assert.equal(source.currentToken().split('.').length, 3);
    return source.subject().then((sub) => {
      assert.equal(sub, '275649063808925701');
    });
  });

  test('refuses a token with no sub, because there is no identity to build subjects from', () => {
    assert.throws(() => staticToken(jwt({ exp: soon() })), /carries no `sub`/);
    assert.throws(() => staticToken('  '), /empty token/);
  });
});

describe('tokenGetter', () => {
  test('caches until the token is close to expiry', async () => {
    let calls = 0;
    const source = tokenGetter({
      getToken: () => {
        calls++;
        return jwt({ sub: '1', exp: soon() });
      },
    });
    await source.token();
    await source.token();
    await source.token();
    assert.equal(calls, 1, 'a callback that does real work must not run on every reconnect');
  });

  test('asks again once the cached token is stale', async () => {
    let calls = 0;
    const source = tokenGetter({
      getToken: () => {
        calls++;
        return jwt({ sub: '1', exp: Math.floor(Date.now() / 1000) + 5 });
      },
    });
    await source.token();
    await source.token();
    assert.equal(calls, 2);
  });

  test('collapses concurrent refreshes into one call', async () => {
    let calls = 0;
    const source = tokenGetter({
      getToken: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jwt({ sub: '1', exp: soon() });
      },
    });
    await Promise.all([source.token(), source.token(), source.token()]);
    assert.equal(calls, 1, 'a reconnect storm must not become a burst of token requests');
  });

  test('currentToken is empty until the first successful token()', async () => {
    // Handing the server an empty token is better than blocking: the connection is refused at
    // once instead of hanging.
    const source = tokenGetter({ getToken: () => jwt({ sub: '1', exp: soon() }) });
    assert.equal(source.currentToken(), '');
    await source.token();
    assert.ok(source.currentToken().length > 0);
  });

  test('accepts an explicit subject for opaque tokens', async () => {
    const source = tokenGetter({ getToken: () => 'opaque', subject: '99' });
    assert.equal(await source.subject(), '99');
  });

  test('says what is wrong when the callback returns nothing', async () => {
    const source = tokenGetter({ getToken: () => '' });
    await assert.rejects(() => source.token(), /returned no token/);
  });
});

describe('OAuth errors', () => {
  test('hint the causes that actually happen against Zitadel', () => {
    assert.match(new OAuthError('unauthorized_client').message, /Device Code.*Native app/s);
    assert.match(new OAuthError('invalid_grant').message, /clock skew/);
    assert.match(new OAuthError('invalid_scope').message, /project id/);
  });

  test('toOAuthError prefers the OAuth shape and falls back to the raw body', () => {
    const oauth = toOAuthError('{"error":"invalid_client","error_description":"no"}', 401);
    assert.ok(oauth instanceof OAuthError);
    assert.equal(oauth.code, 'invalid_client');
    assert.equal(oauth.status, 401);

    const plain = toOAuthError('<html>gateway</html>', 502);
    assert.ok(!(plain instanceof OAuthError));
    assert.match(plain.message, /answered 502.*gateway/s);
  });
});

describe('projectScopes', () => {
  test('adds the two reserved scopes that make a token usable on this bus', () => {
    assert.deepEqual(projectScopes('275672248377933829'), [
      'urn:zitadel:iam:org:projects:roles',
      'urn:zitadel:iam:org:project:id:275672248377933829:aud',
    ]);
  });

  test('adds nothing when there is no project, which is what connects to nothing', () => {
    assert.deepEqual(projectScopes(''), []);
  });
});
