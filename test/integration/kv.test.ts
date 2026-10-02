import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { connect as rawConnect, type NatsConnection } from '@nats-io/transport-node';

import { staticToken } from '../../src/auth/index.ts';
import type { Client } from '../../src/client.ts';
import {
  JikuBucketFull,
  JikuInvalidRequest,
  JikuNoBucket,
  JikuValueTooLarge,
} from '../../src/errors.ts';
import { connect } from '../../src/transport/node.ts';

/**
 * The key-value space against a real JetStream. The bucket is created here, in memory, the way
 * Jiku's deployment creates the real one — this client never creates it.
 *
 * What these cannot show is the PERMISSION boundary: test/nats.conf enforces none. That the three
 * grants confine an identity to its own prefix is pinned by kv.test.ts, by matching every
 * subject the space publishes against the grants it prints.
 */
const TCP = process.env['JIKU_TEST_NATS'] ?? 'nats://localhost:4322';
const WS = process.env['JIKU_TEST_NATS_WS'] ?? 'ws://localhost:8322';

const SUB = '123456789012345678';
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const TOKEN = `${b64({ alg: 'none' })}.${b64({
  sub: SUB,
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.signature`;

const STREAM = 'KV_JIKU_KV';
const MAX_VALUE = 1024;

/** The stream `nats kv add JIKU_KV --history 1` creates, give or take the limits. */
const bucket = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: STREAM,
  subjects: ['$KV.JIKU_KV.>'],
  storage: 'memory',
  retention: 'limits',
  discard: 'new',
  max_msgs_per_subject: 1,
  max_msg_size: MAX_VALUE,
  max_bytes: -1,
  allow_rollup_hdrs: true,
  deny_delete: true,
  allow_direct: true,
  num_replicas: 1,
  ...overrides,
});

const reachable = await isReachable(TCP);

describe(
  'the key-value space over a real JetStream',
  { skip: reachable ? false : `no NATS at ${TCP}` },
  () => {
    let admin: NatsConnection;
    const clients: Client[] = [];

    const open = async (servers = TCP): Promise<Client> => {
      const client = await connect({
        servers,
        instance: 'dev',
        creds: null,
        auth: staticToken(TOKEN),
        timeoutMs: 2000,
      });
      clients.push(client);
      return client;
    };

    const jsApi = async (verb: string, body?: unknown): Promise<Record<string, unknown>> => {
      const reply = await admin.request(
        `$JS.API.STREAM.${verb}.${STREAM}`,
        body === undefined ? '' : JSON.stringify(body),
        { timeout: 2000 },
      );
      return JSON.parse(new TextDecoder().decode(reply.data)) as Record<string, unknown>;
    };

    before(async () => {
      admin = await rawConnect({ servers: TCP, name: 'jiku-ts-kv-admin' });
      await jsApi('DELETE'); // a bucket left behind by an interrupted run
    });

    after(async () => {
      for (const client of clients) {
        await client.close();
      }
      await jsApi('DELETE');
      await admin?.close();
    });

    test('a missing bucket is the deployment to fix, not this client', async () => {
      const client = await open();
      await assert.rejects(
        () => client.kv(),
        (error: unknown) =>
          error instanceof JikuNoBucket && error.message.includes('does not exist'),
      );
    });

    test('a bucket without allow_direct is refused at bind, and binds once it is fixed', async () => {
      const created = await jsApi('CREATE', bucket({ allow_direct: false }));
      assert.equal(created['error'], undefined, JSON.stringify(created));

      const client = await open();
      await assert.rejects(
        () => client.kv(),
        (error: unknown) =>
          error instanceof JikuNoBucket &&
          error.message.includes('allow_direct') &&
          error.message.includes('Do not grant it'),
      );

      const updated = await jsApi('UPDATE', bucket());
      assert.equal(updated['error'], undefined, JSON.stringify(updated));
      // The failure was not cached: the same client binds now.
      await client.kv();
    });

    test('put, get and delete round-trip, under the identity prefix', async () => {
      const space = await (await open()).kv();

      const revision = await space.put('preferences.theme', 'dark');
      const entry = await space.get('preferences.theme');
      assert.ok(entry);
      assert.equal(entry.key, 'preferences.theme', 'the key comes back as the caller wrote it');
      assert.equal(new TextDecoder().decode(entry.value), 'dark');
      assert.equal(entry.revision, revision);
      assert.ok(Math.abs(entry.created.getTime() - Date.now()) < 10_000, String(entry.created));

      // What reached the bucket carries the identity. Read it the way any other client would.
      const raw = await admin.request(
        `$JS.API.DIRECT.GET.${STREAM}.$KV.JIKU_KV.dev.${SUB}.preferences.theme`,
        '',
        { timeout: 2000 },
      );
      assert.equal(raw.headers?.get('Nats-Subject'), `$KV.JIKU_KV.dev.${SUB}.preferences.theme`);
      assert.equal(new TextDecoder().decode(raw.data), 'dark');

      await space.delete('preferences.theme');
      assert.equal(await space.get('preferences.theme'), undefined, 'a deleted key is a miss');
    });

    test('a key never written is a miss, not a failure', async () => {
      const space = await (await open()).kv();
      assert.equal(await space.get('never.written'), undefined);
      await space.delete('never.written'); // deleting nothing succeeds
    });

    test('the revision orders writes across every key of the bucket', async () => {
      const space = await (await open()).kv();
      const first = await space.put('order.a', new Uint8Array([1]));
      const second = await space.put('order.b', new Uint8Array([2]));
      const third = await space.put('order.a', new Uint8Array([3]));
      assert.ok(
        first < second && second < third,
        `${String(first)}, ${String(second)}, ${String(third)}`,
      );
      assert.deepEqual((await space.get('order.a'))?.value, new Uint8Array([3]));
    });

    test('a key NATS would refuse never reaches the bus', async () => {
      const space = await (await open()).kv();
      await assert.rejects(() => space.put('a..b', 'x'), JikuInvalidRequest);
      await assert.rejects(() => space.get('a.>'), JikuInvalidRequest);
    });

    test("a value over the bucket's maximum is too large, and says whose limit it is", async () => {
      const space = await (await open()).kv();
      await assert.rejects(
        () => space.put('big', new Uint8Array(MAX_VALUE * 2)),
        (error: unknown) =>
          error instanceof JikuValueTooLarge && error.message.includes('maximum value size'),
      );
    });

    test('a full bucket says the limit is shared by every identity', async () => {
      const updated = await jsApi('UPDATE', bucket({ max_bytes: 4 * MAX_VALUE }));
      assert.equal(updated['error'], undefined, JSON.stringify(updated));
      const space = await (await open()).kv();
      try {
        await assert.rejects(
          async () => {
            for (let i = 0; i < 64; i++) {
              await space.put(`fill.${String(i)}`, new Uint8Array(MAX_VALUE - 200));
            }
          },
          (error: unknown) =>
            error instanceof JikuBucketFull && error.message.includes('shared by every identity'),
        );
      } finally {
        await jsApi('UPDATE', bucket());
      }
    });

    test('is the same space over a socket a browser can open', async (t) => {
      if (!(await isReachable(WS))) {
        t.skip(`no WebSocket NATS at ${WS}`);
        return;
      }
      const tcp = await (await open()).kv();
      const ws = await (await open(WS)).kv();
      await tcp.put('shared.across.transports', 'same');
      const entry = await ws.get('shared.across.transports');
      assert.equal(new TextDecoder().decode(entry?.value), 'same');
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
  } catch {
    return false;
  }
}
