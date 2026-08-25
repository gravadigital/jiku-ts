import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { base64UrlDecode } from '../src/auth/claims.ts';
import { expandHome, loadConfig, parseTimeout } from '../src/node/config.ts';
import { ServiceUser } from '../src/node/service-user.ts';
import { FileStore, MemoryStore, configDir, defaultStorePath } from '../src/node/store.ts';

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jiku-ts-test-'));
});

describe('parseTimeout', () => {
  test('reads the duration syntax the config file uses', () => {
    // `timeout: 15s` is what is actually written in the file, so that spelling has to work.
    assert.equal(parseTimeout('15s'), 15_000);
    assert.equal(parseTimeout('1m30s'), 90_000);
    assert.equal(parseTimeout('500ms'), 500);
    assert.equal(parseTimeout('2h'), 7_200_000);
  });

  test('reads a bare number as milliseconds, which is what a JS caller means', () => {
    assert.equal(parseTimeout(15_000), 15_000);
    assert.equal(parseTimeout('15000'), 15_000);
  });

  test('is undefined for nothing, and an error for nonsense', () => {
    assert.equal(parseTimeout(undefined), undefined);
    assert.equal(parseTimeout(''), undefined);
    assert.equal(parseTimeout(0), undefined);
    assert.throws(() => parseTimeout('soon'), /not a duration/);
  });
});

describe('expandHome', () => {
  test('resolves a leading ~, which the OS does not do for us', () => {
    assert.ok(expandHome('~/x')?.startsWith('/'));
    assert.equal(expandHome('/absolute'), '/absolute');
    assert.equal(expandHome(undefined), undefined);
  });
});

describe('loadConfig', () => {
  test('reads the shared config file, with the keys it actually uses', async () => {
    // The file spells them snake_case. Insisting on camelCase would mean a second config file
    // on the machine, pointing at the same bus.
    const path = join(dir, 'config.yaml');
    await writeFile(
      path,
      [
        'servers: nats://example:4222',
        'instance: prod',
        'creds: /etc/jiku/sentinel.creds',
        'timeout: 20s',
        'zitadel:',
        '  issuer: https://id.example',
        '  client_id: abc@project',
        '  project_id: "12345"',
      ].join('\n'),
    );
    const config = await loadConfig(path);
    assert.equal(config.servers, 'nats://example:4222');
    assert.equal(config.instance, 'prod');
    assert.equal(config.credsFile, '/etc/jiku/sentinel.creds');
    assert.equal(config.timeoutMs, 20_000);
    assert.equal(config.zitadel.clientId, 'abc@project');
    assert.equal(config.zitadel.projectId, '12345');
    assert.equal(config.path, path);
  });

  test('a missing file is not an error — the environment is a fine way to configure this', async () => {
    const config = await loadConfig(join(dir, 'does-not-exist.yaml'));
    assert.equal(config.instance, 'dev');
    assert.equal(config.zitadel.issuer, 'https://id.grava.io');
    assert.equal(config.path, undefined);
  });

  test('the environment overrides the file', async () => {
    const path = join(dir, 'env.yaml');
    await writeFile(path, 'instance: prod\nservers: nats://file:4222\n');
    process.env['JIKU_INSTANCE'] = 'staging';
    process.env['JIKU_SERVERS'] = 'nats://env:4222';
    try {
      const config = await loadConfig(path);
      assert.equal(config.instance, 'staging');
      assert.equal(config.servers, 'nats://env:4222');
    } finally {
      delete process.env['JIKU_INSTANCE'];
      delete process.env['JIKU_SERVERS'];
    }
  });

  test('refuses a file that is not a mapping instead of guessing', async () => {
    const path = join(dir, 'bad.yaml');
    await writeFile(path, '- a\n- b\n');
    await assert.rejects(() => loadConfig(path), /does not contain a YAML mapping/);
  });

  test('reads the config directory from XDG, like the CLI', () => {
    assert.ok(configDir().endsWith('jiku'));
    assert.ok(defaultStorePath('prod').endsWith('tokens-prod.json'));
    assert.ok(defaultStorePath().endsWith('tokens-dev.json'));
  });
});

describe('FileStore', () => {
  test('nothing stored is not an error, it just means nobody logged in yet', async () => {
    assert.equal(await new FileStore(join(dir, 'none.json')).load(), undefined);
  });

  test('writes 0600, because the file holds a refresh token', async () => {
    const path = join(dir, 'tokens.json');
    const store = new FileStore(path);
    await store.save({ access_token: 'a', refresh_token: 'r' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await store.load(), { access_token: 'a', refresh_token: 'r' });
  });

  test('re-tightens a file that already existed with looser permissions', async () => {
    // writeFile's `mode` only applies on CREATE, so a file left world-readable by something
    // else would otherwise keep those permissions forever.
    const path = join(dir, 'loose.json');
    await writeFile(path, '{}');
    await chmod(path, 0o644);
    await new FileStore(path).save({ access_token: 'a' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  test('warns rather than failing when it finds a token readable by everyone', async () => {
    const path = join(dir, 'warn.json');
    await writeFile(path, '{"access_token":"a"}');
    await chmod(path, 0o644);
    const warnings: string[] = [];
    await new FileStore(path, (message) => warnings.push(message)).load();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /readable beyond its owner/);
  });

  test('writes a token file other clients on the machine can read back', async () => {
    // ~/.config/jiku/tokens-<instance>.json is a shared location, and `obtained_at` is a
    // timestamp string there — a stricter date type than JavaScript's will not take a number.
    const path = join(dir, 'interop.json');
    await new FileStore(path).save({ access_token: 'a', obtained_at: new Date().toISOString() });
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    assert.equal(typeof parsed['obtained_at'], 'string');
    assert.match(parsed['obtained_at'] as string, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('says what to do about a corrupt file', async () => {
    const path = join(dir, 'corrupt.json');
    await writeFile(path, 'not json');
    await assert.rejects(() => new FileStore(path).load(), /Delete it and log in again/);
  });
});

describe('MemoryStore', () => {
  test('round-trips within the process and nowhere else', async () => {
    const store = new MemoryStore();
    assert.equal(await store.load(), undefined);
    await store.save({ access_token: 'a' });
    assert.deepEqual(await store.load(), { access_token: 'a' });
  });
});

describe('ServiceUser', () => {
  const options = { issuer: 'https://id.example', projectId: '123' };

  const makeKey = (type: 'pkcs1' | 'pkcs8') => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: type === 'pkcs1' ? 'pkcs1' : 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    return {
      publicKey,
      key: { type: 'serviceaccount', keyId: 'k1', key: privateKey, userId: '387842544790142978' },
    };
  };

  test('accepts both PEM encodings Zitadel has used', () => {
    // PKCS#1 ("RSA PRIVATE KEY") and PKCS#8 ("PRIVATE KEY").
    for (const type of ['pkcs1', 'pkcs8'] as const) {
      const { key } = makeKey(type);
      assert.doesNotThrow(() => new ServiceUser(key, options), type);
    }
  });

  test('knows its own subject without a network call', async () => {
    const { key } = makeKey('pkcs8');
    const user = new ServiceUser(key, options);
    assert.equal(user.userId, '387842544790142978');
    assert.equal(await user.subject(), '387842544790142978');
    assert.equal(user.currentToken(), '');
  });

  test('signs an assertion Zitadel would accept', async () => {
    const { key, publicKey } = makeKey('pkcs8');
    let assertion = '';
    const user = new ServiceUser(key, {
      ...options,
      fetch: (async (url: string, init: RequestInit) => {
        const body = new URLSearchParams(String(init.body));
        if (String(url).includes('.well-known')) {
          return new Response(
            JSON.stringify({ token_endpoint: 'https://id.example/oauth/v2/token' }),
            { status: 200 },
          );
        }
        assertion = body.get('assertion') ?? '';
        assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
        assert.match(body.get('scope') ?? '', /urn:zitadel:iam:org:projects:roles/);
        // `profile` is not optional here: without it the callout's authentication event has no
        // name, core discards it, and every later request answers caller_not_authorized.
        assert.match(body.get('scope') ?? '', /\bprofile\b/);
        return new Response(JSON.stringify({ access_token: 'minted', expires_in: 3600 }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });

    assert.equal(await user.token(), 'minted');
    assert.equal(user.currentToken(), 'minted');

    const [header, payload, signature] = assertion.split('.') as [string, string, string];
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    assert.ok(
      verifier.verify(publicKey, Buffer.from(base64UrlDecode(signature))),
      'the assertion signature does not verify against its own public key',
    );

    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as Record<
      string,
      unknown
    >;
    // iss and sub are both the machine user: the key holder asserts its own identity.
    assert.equal(claims['iss'], '387842544790142978');
    assert.equal(claims['sub'], '387842544790142978');
    assert.equal(claims['aud'], 'https://id.example');
    assert.ok((claims['exp'] as number) > (claims['iat'] as number));

    const parsedHeader = JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as Record<
      string,
      unknown
    >;
    assert.equal(parsedHeader['alg'], 'RS256');
    assert.equal(parsedHeader['kid'], 'k1');
  });

  test('says what a key file is missing rather than failing later', () => {
    assert.throws(
      () => ServiceUser.fromJson('{"keyId":"k"}', options),
      /missing key, keyId or userId/,
    );
    assert.throws(() => ServiceUser.fromJson('not json', options), /not a PEM on its own/);
  });

  test('refuses a key that is not RSA', () => {
    const { privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    assert.throws(
      () => new ServiceUser({ keyId: 'k', key: privateKey, userId: '1' }, options),
      /not RSA/,
    );
  });
});

after(() => {
  // The temp directory is left for the OS to reap; nothing in it is a credential that matters.
});
