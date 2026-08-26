import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseServers, resolveOptions, transportOf } from '../src/config.ts';
import { JikuInvalidRequest } from '../src/errors.ts';
import { staticToken } from '../src/auth/static.ts';

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const TOKEN = `${b64({ alg: 'none' })}.${b64({ sub: '42' })}.sig`;
const auth = staticToken(TOKEN);

describe('parseServers', () => {
  test('accepts a comma-separated string or an array', () => {
    assert.deepEqual(parseServers('a, b ,c'), ['a', 'b', 'c']);
    assert.deepEqual(parseServers(['a', ' b ']), ['a', 'b']);
    assert.deepEqual(parseServers(undefined), []);
    assert.deepEqual(parseServers(',,'), []);
  });
});

describe('transportOf', () => {
  test('picks the transport from the URL scheme', () => {
    assert.equal(transportOf(['nats://localhost:4222']), 'tcp');
    assert.equal(transportOf(['tls://host:4222']), 'tcp');
    assert.equal(transportOf(['ws://host:8080']), 'ws');
    assert.equal(transportOf(['wss://host:443', 'wss://other:443']), 'ws');
  });

  test('refuses a list that mixes the two, which one connection cannot do', () => {
    assert.throws(
      () => transportOf(['nats://a:4222', 'wss://b:443']),
      (error: unknown) => {
        assert.ok(error instanceof JikuInvalidRequest);
        assert.match(error.message, /mixes WebSocket and TCP/);
        return true;
      },
    );
  });
});

describe('resolveOptions', () => {
  test('fills in the defaults', () => {
    const resolved = resolveOptions({ auth, creds: null });
    assert.deepEqual(resolved.servers, ['nats://localhost:4222']);
    assert.equal(resolved.instance, 'dev');
    assert.equal(resolved.timeoutMs, 15_000);
    assert.equal(resolved.name, 'jiku-ts');
  });

  test('names what is missing and where it comes from', () => {
    assert.throws(
      () => resolveOptions({ auth }),
      (error: unknown) => {
        assert.match((error as Error).message, /creds or credsFile \(JIKU_CREDS\)/);
        return true;
      },
    );
    assert.throws(() => resolveOptions({ creds: null } as never), /auth — a token source/);
  });

  test('distinguishes "no creds needed" from "creds forgotten"', () => {
    // An unset environment variable produces undefined, so `null` can only ever be deliberate.
    assert.doesNotThrow(() => resolveOptions({ auth, creds: null }));
    assert.throws(() => resolveOptions({ auth }), /creds or credsFile/);
  });

  test('refuses a non-positive timeout instead of using it', () => {
    assert.equal(resolveOptions({ auth, creds: null, timeoutMs: 0 }).timeoutMs, 15_000);
    assert.equal(resolveOptions({ auth, creds: null, timeoutMs: -1 }).timeoutMs, 15_000);
    assert.equal(resolveOptions({ auth, creds: null, timeoutMs: 500 }).timeoutMs, 500);
  });
});
