import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { staticToken } from '../../src/auth/index.ts';
import type { Client } from '../../src/client.ts';
import {
  ErrorCode,
  JikuError,
  JikuFailure,
  JikuNoEndpoint,
  JikuTimeout,
  isCode,
} from '../../src/errors.ts';
import { anyOf, gte } from '../../src/query.ts';
import { inboxPrefix } from '../../src/subject.ts';
import { connect } from '../../src/transport/node.ts';
import { PROJECT_COUNT, startFakeCore, type FakeCore } from './harness.ts';

/**
 * These run against any NATS, with a stand-in core. Point them at one with:
 *
 * ```sh
 * npm run nats:up          # a throwaway NATS with TCP on 4322 and WebSocket on 8322
 * npm run test:integration
 * ```
 *
 * They are skipped when no server is configured, so `npm test` stays hermetic.
 */
const TCP = process.env['JIKU_TEST_NATS'] ?? 'nats://localhost:4322';
const WS = process.env['JIKU_TEST_NATS_WS'] ?? 'ws://localhost:8322';

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const TOKEN = `${b64({ alg: 'none' })}.${b64({
  sub: '275649063808925701',
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.signature`;

// Reachability is probed once, at module load, so a machine with no NATS skips these rather
// than failing them. TOKEN has to exist first: `const` is in its temporal dead zone until then,
// and isReachable() would swallow the ReferenceError as "unreachable".
const reachable = await isReachable(TCP);
const wsReachable = reachable && (await isReachable(WS));

describe('protocol over a real bus', { skip: reachable ? false : `no NATS at ${TCP}` }, () => {
  let core: FakeCore;
  let client: Client;

  before(async () => {
    core = await startFakeCore(TCP);
    client = await connect({
      servers: TCP,
      instance: 'dev',
      creds: null,
      auth: staticToken(TOKEN),
      timeoutMs: 2000,
    });
  });

  after(async () => {
    await client?.close();
    await core?.stop();
  });

  test('publishes on the subject core subscribes to, from the inbox it is allowed', async () => {
    await client.list('projects', { limit: 3 });
    assert.equal(core.seen.at(-1), 'dev.275649063808925701.jiku-queries.v1.projects.list');
    assert.equal(client.inboxPrefix, await inboxPrefix('275649063808925701'));
  });

  test('renders the six levers into the wire shape', async () => {
    await client.list('projects', {
      filter: { id: 1, status: anyOf('activo'), createdAt: gte('2026-01-01') },
      sort: ['-createdAt'],
      fields: ['id'],
      include: ['client'],
      limit: 5,
      count: true,
    });
    assert.deepEqual(core.payloads.at(-1), {
      filter: { id: 1, status: ['activo'], createdAt: { gte: '2026-01-01' } },
      sort: ['-createdAt'],
      fields: ['id'],
      include: ['client'],
      page: { limit: 5 },
      count: true,
    });
  });

  test('a short page with a cursor is NOT the end of the collection', async () => {
    // The stand-in core returns limit-1 items on the first page, on purpose: the byte budget
    // makes this happen for real, and a loop that stops on `items.length < limit` truncates.
    const first = await client.list<{ id: number }>('projects', { limit: 4 });
    assert.equal(first.items.length, 3);
    assert.ok(first.page.cursor, 'a short page must still carry its cursor');
  });

  test('iterate follows every cursor and stops only when one is absent', async () => {
    const ids: number[] = [];
    for await (const project of client.iterate<{ id: number }>('projects', { limit: 2 })) {
      ids.push(project.id);
    }
    assert.equal(ids.length, PROJECT_COUNT);
    assert.deepEqual(new Set(ids).size, PROJECT_COUNT, 'no item may be yielded twice');
  });

  test('all() agrees with iterate, and count() agrees with both', async () => {
    const all = await client.all('projects', { limit: 3 });
    assert.equal(all.length, PROJECT_COUNT);
    assert.equal(await client.count('projects'), PROJECT_COUNT);
  });

  test('iteratePages hands back the page metadata', async () => {
    const limits: number[] = [];
    for await (const page of client.iteratePages('projects', { limit: 2 })) {
      limits.push(page.page.returned);
    }
    assert.equal(
      limits.reduce((a, b) => a + b, 0),
      PROJECT_COUNT,
    );
  });

  test('a get comes back flat, and its failure carries the details', async () => {
    assert.deepEqual(await client.get('projects', { id: 100 }), { id: 100, name: 'project 0' });
    await assert.rejects(
      () => client.get('projects', { id: 999 }),
      (error: unknown) => {
        assert.ok(isCode(error, ErrorCode.ProjectNotFound));
        assert.equal((error as JikuFailure).details?.value, 999);
        assert.equal((error as JikuFailure).method, 'projects.get');
        return true;
      },
    );
  });

  test('request() hands back a failure envelope without throwing', async () => {
    const reply = await client.request('jiku-queries', 'projects.get', { id: 999 });
    assert.equal(reply.status, 'failure');
    assert.equal(reply.errorCode, 'project_not_found');
  });

  test('tags is not paginated and comes back as its own shape', async () => {
    assert.deepEqual(await client.tags(15), [
      { key: 'modulo', values: ['facturacion', 'reportes'] },
    ]);
  });

  test('the contract is fetched once and cached for the life of the client', async () => {
    const before = core.seen.filter((s) => s.endsWith('meta.describe')).length;
    const [a, b] = await Promise.all([client.contract(), client.contract()]);
    assert.equal(a, b, 'the same object must come back');
    const after = core.seen.filter((s) => s.endsWith('meta.describe')).length;
    assert.equal(after - before, 1, 'two concurrent callers must not both issue the request');
  });

  test('resource() resolves the contract down to one resource', async () => {
    const projects = await client.resource('projects');
    assert.deepEqual(projects.sortable, ['id', 'createdAt']);
    assert.equal(projects.defaults.maxLimit, 200);
  });

  test('a method nothing answers is a no-endpoint, not a timeout', async () => {
    // The bus says so immediately. It is a firmer signal than a timeout and deserves its own
    // class, because the fix is different.
    await assert.rejects(
      () => client.query('nope.list'),
      (error: unknown) => {
        assert.ok(error instanceof JikuFailure || error instanceof JikuNoEndpoint);
        return true;
      },
    );
  });

  test('an endpoint that never answers times out with the diagnosis, not just the fact', async () => {
    await assert.rejects(
      () => client.query('slow.list', {}, { timeoutMs: 300 }),
      (error: unknown) => {
        assert.ok(error instanceof JikuTimeout, String(error));
        assert.match(error.message, /is the instance right\?/);
        assert.match(error.message, /inbox prefix, the other classic cause, is set correctly/);
        return true;
      },
    );
  });

  test('an AbortSignal stops the wait', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new Error('caller changed their mind'));
    }, 50);
    await assert.rejects(
      () => client.query('slow.list', {}, { signal: controller.signal }),
      /caller changed their mind/,
    );
  });

  test('an already-aborted signal never publishes', async () => {
    await assert.rejects(
      () => client.query('projects.list', {}, { signal: AbortSignal.abort(new Error('nope')) }),
      /nope/,
    );
  });

  test('a reply that is not an envelope shows the bytes', async () => {
    await assert.rejects(
      () => client.query('garbage.list'),
      (error: unknown) => {
        assert.ok(error instanceof JikuError);
        assert.match(error.message, /502 Bad Gateway/);
        return true;
      },
    );
  });

  test('a forbidden identity field never reaches the network', async () => {
    const before = core.seen.length;
    await assert.rejects(
      () => client.query('projects.list', { userId: 1 }),
      /forbidden identity field/,
    );
    assert.equal(core.seen.length, before, 'nothing may have been published');
  });

  test('a closed client refuses to publish', async () => {
    const other = await connect({
      servers: TCP,
      instance: 'dev',
      creds: null,
      auth: staticToken(TOKEN),
    });
    await other.close();
    assert.equal(other.closed, true);
    await assert.rejects(() => other.query('projects.list'), /not connected/);
  });

  test('the client disposes itself where the syntax exists', async () => {
    // `await using` is Node 24+ syntax and this package supports Node 22, so the protocol is
    // exercised through the symbol rather than through the keyword — which is what the keyword
    // calls anyway, and what a TypeScript build downlevels to.
    const disposable = await connect({
      servers: TCP,
      instance: 'dev',
      creds: null,
      auth: staticToken(TOKEN),
    });
    assert.equal(typeof disposable[Symbol.asyncDispose], 'function');
    assert.equal(disposable.closed, false);
    await disposable[Symbol.asyncDispose]();
    assert.equal(disposable.closed, true);
  });
});

describe(
  'the same protocol over a WebSocket',
  { skip: wsReachable ? false : `no WebSocket NATS at ${WS}` },
  () => {
    let core: FakeCore;
    let client: Client;

    before(async () => {
      core = await startFakeCore(TCP);
      client = await connect({
        servers: WS,
        instance: 'dev',
        creds: null,
        auth: staticToken(TOKEN),
        timeoutMs: 2000,
      });
    });

    after(async () => {
      await client?.close();
      await core?.stop();
    });

    test('is the same client, over a socket a browser can open', async () => {
      assert.match(client.connectedUrl, /8322/);
      const all = await client.all('projects', { limit: 2 });
      assert.equal(all.length, PROJECT_COUNT);
      assert.equal(await client.count('projects'), PROJECT_COUNT);
    });
  },
);

async function isReachable(url: string): Promise<boolean> {
  try {
    const client = await connect({
      servers: url,
      creds: null,
      auth: staticToken(TOKEN),
      nats: { maxReconnectAttempts: 0, timeout: 1500 },
    });
    await client.close();
    return true;
  } catch (error) {
    if (process.env['JIKU_TEST_DEBUG']) {
      globalThis.console.error(`[reachability] ${url}:`, error);
    }
    return false;
  }
}
