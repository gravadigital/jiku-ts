import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  headers,
  InvalidArgumentError,
  NoRespondersError,
  PermissionViolationError,
  RequestError,
  TimeoutError,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
} from '@nats-io/nats-core';

import { Client } from '../src/client.ts';
import {
  JikuBucketFull,
  JikuInvalidRequest,
  JikuKVPermissionDenied,
  JikuNoBucket,
  JikuNotConnected,
  JikuTimeout,
  JikuValueTooLarge,
} from '../src/errors.ts';
import {
  checkKVStream,
  kvKey,
  kvReadSubject,
  kvWriteSubject,
  requiredKVPermissions,
} from '../src/kv.ts';

const ME = '275649063808925701';
const OTHER = '999999999999999999';
const INFO = '$JS.API.STREAM.INFO.KV_JIKU_KV';

interface Call {
  subject: string;
  data: Uint8Array;
  headers: MsgHdrs | undefined;
}

type Answer = (call: Call) => Msg | Promise<Msg>;

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const reply = (data: Uint8Array, h?: MsgHdrs): Msg => ({ data, headers: h }) as unknown as Msg;
const json = (value: unknown): Msg => reply(encode(value));

/** What a healthy bucket answers: a bound stream, acks with a sequence, nothing stored. */
const healthy: Answer = (call) => {
  if (call.subject === INFO) {
    return json({ config: { name: 'KV_JIKU_KV', allow_direct: true } });
  }
  if (call.subject.startsWith('$KV.')) {
    return json({ stream: 'KV_JIKU_KV', seq: 7 });
  }
  return reply(new Uint8Array(0), headers(404, 'Message Not Found'));
};

/**
 * A client over a stand-in connection. It records every request, and answers through `answer`.
 * Nothing in the key-value space touches the connection except `request`, `isClosed` and `info`.
 */
function fakeClient(answer: Answer = healthy, userId = ME): { client: Client; calls: Call[] } {
  const calls: Call[] = [];
  const nc = {
    request: async (subject: string, data: Uint8Array, opts?: { headers?: MsgHdrs }) => {
      const call = { subject, data, headers: opts?.headers };
      calls.push(call);
      return answer(call);
    },
    isClosed: () => false,
    drain: async () => {
      // Nothing in flight.
    },
    status: async function* () {
      // No status events.
    },
    info: { max_payload: 1_048_576 },
  } as unknown as NatsConnection;
  return { client: Client.fromConnection(nc, { userId, instance: 'dev', timeoutMs: 5000 }), calls };
}

/** Fails every operation but the bind with `error`. */
const failingWith =
  (error: Error): Answer =>
  (call) => {
    if (call.subject === INFO) {
      return healthy(call);
    }
    throw error;
  };

/** Answers every write with a JetStream API error. */
const refusingWith =
  (code: number, errCode: number, description: string): Answer =>
  (call) =>
    call.subject === INFO
      ? healthy(call)
      : json({ error: { code, err_code: errCode, description } });

describe('kvKey', () => {
  test('puts the identity second and no version anywhere', () => {
    assert.equal(kvKey('dev', ME, 'preferences.theme'), `dev.${ME}.preferences.theme`);
  });
});

describe('the subjects and the grants', () => {
  // The space is only as narrow as the permissions it asks for. Every subject it publishes must
  // be covered by a line requiredKVPermissions prints, and the same subjects under another
  // identity must NOT be: a grant that matches both is a space shared by everybody. If the
  // subject grammar and the printed grants drift apart, the first half fails. If a grant widens,
  // the second half fails.
  test('every subject is granted to its own identity and to no other', () => {
    const grants = pubAllowLines(requiredKVPermissions('dev')).map((grant) =>
      grant.replace('{{user_id}}', ME),
    );
    const subjects = (user: string): Record<string, string> => {
      const full = kvKey('dev', user, 'preferences.theme');
      return { 'put/delete': kvWriteSubject(full), get: kvReadSubject(full), bind: INFO };
    };

    for (const [op, subject] of Object.entries(subjects(ME))) {
      assert.ok(
        grants.some((grant) => matches(grant, subject)),
        `${op} publishes ${subject}, which no printed grant covers:\n  ${grants.join('\n  ')}`,
      );
    }
    for (const [op, subject] of Object.entries(subjects(OTHER))) {
      if (op === 'bind') {
        continue; // STREAM.INFO names the bucket, not an identity
      }
      assert.ok(
        !grants.some((grant) => matches(grant, subject)),
        `${op} under ANOTHER identity (${subject}) is covered by my grants: the space is shared`,
      );
    }
  });

  // Its bare form takes the key in the body, which no subject permission can confine.
  test('a get carries the key in the subject', () => {
    assert.equal(
      kvReadSubject(kvKey('dev', ME, 'a.b')),
      `$JS.API.DIRECT.GET.KV_JIKU_KV.$KV.JIKU_KV.dev.${ME}.a.b`,
    );
  });

  test('the permissions warn against the wide grants without granting any', () => {
    const message = requiredKVPermissions('dev');
    const grants = pubAllowLines(message);
    for (const wide of [
      '$KV.JIKU_KV.>',
      '$JS.API.DIRECT.GET.KV_JIKU_KV',
      '$JS.API.STREAM.MSG.GET.KV_JIKU_KV',
      '$JS.API.>',
    ]) {
      assert.ok(!grants.includes(wide), `the message GRANTS ${wide}`);
      assert.ok(message.includes(`"${wide}"`), `the message never warns against ${wide}`);
    }
    assert.match(message, /Do NOT grant/);
  });
});

describe('the space', () => {
  // The prefix is the identity. Every key reaching the bucket must carry it, and the entry
  // handed back must not, so a caller never sees or writes an identity by hand.
  test('stays under the identity prefix and hands keys back without it', async () => {
    const stored = headers();
    stored.set('Nats-Sequence', '7');
    stored.set('Nats-Time-Stamp', '2026-10-02T12:00:00.123456789Z');
    const { client, calls } = fakeClient((call) =>
      call.subject.startsWith('$JS.API.DIRECT.GET.')
        ? reply(new TextEncoder().encode('dark'), stored)
        : healthy(call),
    );
    const space = await client.kv();

    assert.equal(await space.put('preferences.theme', 'dark'), 7);
    const entry = await space.get('preferences.theme');
    await space.delete('preferences.theme');

    assert.ok(entry);
    assert.equal(entry.key, 'preferences.theme');
    assert.equal(new TextDecoder().decode(entry.value), 'dark');
    assert.equal(entry.revision, 7);
    assert.equal(entry.created.toISOString(), '2026-10-02T12:00:00.123Z');

    const full = `dev.${ME}.preferences.theme`;
    assert.deepEqual(
      calls.map((call) => call.subject),
      [INFO, kvWriteSubject(full), kvReadSubject(full), kvWriteSubject(full)],
    );
    assert.equal(calls[2]?.data.length, 0, 'a get carries nothing in the body');
    assert.equal(calls[3]?.headers?.get('KV-Operation'), 'DEL', 'a delete is a marked write');
  });

  test('a miss and a deleted key are undefined, not a failure', async () => {
    const marker = headers();
    marker.set('KV-Operation', 'DEL');
    marker.set('Nats-Sequence', '9');
    let deleted = false;
    const { client } = fakeClient((call) => {
      if (call.subject.startsWith('$JS.API.DIRECT.GET.')) {
        return deleted
          ? reply(new Uint8Array(0), marker)
          : reply(new Uint8Array(0), headers(404, 'Message Not Found'));
      }
      return healthy(call);
    });
    const space = await client.kv();

    assert.equal(await space.get('never.written'), undefined);
    deleted = true;
    assert.equal(await space.get('deleted'), undefined);
  });

  // The cases are NATS's own rules. Rejecting anything it accepts would make a valid call
  // impossible, so the accepted half matters as much as the refused one.
  test('refuses what NATS would, accepts what it does, and the bus never sees a refusal', async () => {
    const { client, calls } = fakeClient();
    const space = await client.kv();
    calls.length = 0;

    for (const key of ['', '.a', 'a.', 'a..b', 'a b', 'a*', 'a.>', 'ñandú', 'a:b', '😀']) {
      await assert.rejects(() => space.put(key, 'x'), JikuInvalidRequest, JSON.stringify(key));
    }
    assert.deepEqual(calls, [], 'rejected keys reached the bus');

    for (const key of ['a', 'a.b', 'A-1_b/c=d', 'cache.tasks.15', 'x/y/z']) {
      await space.put(key, 'x');
    }
    assert.equal(calls.length, 5);
  });

  test('an identity that cannot be a key segment is refused before anything is sent', async () => {
    const { client, calls } = fakeClient(healthy, 'a.b');
    await assert.rejects(() => client.kv(), /user id "a\.b" cannot be a segment/);
    assert.deepEqual(calls, []);
  });
});

describe('binding', () => {
  test('happens once per client, even when asked twice at once', async () => {
    const { client, calls } = fakeClient();
    const [a, b] = await Promise.all([client.kv(), client.kv()]);
    assert.equal(a, b);
    assert.equal(calls.filter((call) => call.subject === INFO).length, 1);
  });

  // Without allow_direct, a get goes to a subject that no permission can confine. The bucket is
  // refused at bind, and the message must not suggest the grant that would leak every
  // identity's entries.
  test('refuses a bucket without allow_direct, and does not cache the refusal', async () => {
    let direct = false;
    const { client } = fakeClient((call) =>
      call.subject === INFO ? json({ config: { allow_direct: direct } }) : healthy(call),
    );
    await assert.rejects(
      () => client.kv(),
      (error: unknown) =>
        error instanceof JikuNoBucket &&
        ['allow_direct', 'STREAM.MSG.GET', 'Do not grant it'].every((part) =>
          error.message.includes(part),
        ),
    );
    direct = true;
    await client.kv();

    assert.doesNotThrow(() => {
      checkKVStream({ allow_direct: true });
    });
  });

  test('a closed client has no space', async () => {
    const { client } = fakeClient();
    await client.close();
    await assert.rejects(() => client.kv(), JikuNotConnected);
  });
});

describe('errors name the fix', () => {
  const subject = kvWriteSubject(kvKey('dev', ME, 'theme'));

  // A refused publish is dropped and reported on the connection's error channel. The NATS client
  // correlates it with the request in flight and rejects it at once; this has to say it was the
  // BUS, and carry the grant, instead of calling it JetStream's silence.
  test('a refused subject is the bus, with the grants', async () => {
    const refusal = new RequestError('permissions violation', {
      cause: new PermissionViolationError(
        `Permissions Violation for Publish to "${subject}"`,
        'publish',
        subject,
      ),
    });
    const space = await fakeClient(failingWith(refusal)).client.kv();
    await assert.rejects(
      () => space.put('theme', 'dark'),
      (error: unknown) =>
        error instanceof JikuKVPermissionDenied &&
        error.subject === subject &&
        error.message.includes('$KV.JIKU_KV.dev.{{user_id}}.>'),
    );
  });

  const cases: {
    name: string;
    answer: Answer;
    is: new (...args: never[]) => Error;
    says: string[];
  }[] = [
    {
      name: "over the bucket's value size",
      answer: refusingWith(400, 10054, 'message size exceeds maximum allowed'),
      is: JikuValueTooLarge,
      says: ['maximum value size'],
    },
    {
      name: 'over max_payload',
      answer: failingWith(InvalidArgumentError.format('payload', 'max_payload size exceeded')),
      is: JikuValueTooLarge,
      says: ['max_payload of 1048576 bytes'],
    },
    {
      name: 'bucket full',
      answer: refusingWith(503, 10077, 'maximum bytes exceeded'),
      is: JikuBucketFull,
      says: ['shared by every identity', 'TTL'],
    },
    {
      name: 'nothing stores the subject',
      answer: failingWith(new RequestError('', { cause: new NoRespondersError(subject) })),
      is: JikuNoBucket,
      says: [subject, 'removed after it was bound'],
    },
    {
      name: 'jetstream disabled for the account',
      answer: refusingWith(503, 10039, 'jetstream not enabled for account'),
      is: JikuNoBucket,
      says: ['not enabled'],
    },
  ];

  for (const { name, answer, is, says } of cases) {
    test(name, async () => {
      const space = await fakeClient(answer).client.kv();
      await assert.rejects(
        () => space.put('theme', 'dark'),
        (error: unknown) => {
          assert.ok(error instanceof is, `${String(error)} is not a ${is.name}`);
          for (const part of says) {
            assert.ok(error.message.includes(part), `never mentions ${part}:\n${error.message}`);
          }
          return true;
        },
      );
    });
  }

  // A store failure that is NOT a limit must not be reported as a full bucket. That would send
  // the reader deleting entries over a disk error.
  test('a store failure that is not a limit is not a full bucket', async () => {
    const space = await fakeClient(refusingWith(503, 10077, 'write failed: no space')).client.kv();
    await assert.rejects(
      () => space.put('theme', 'dark'),
      (error: unknown) => !(error instanceof JikuBucketFull) && String(error).includes('no space'),
    );
  });

  // JikuTimeout says "no reply from core", and core is not involved here.
  test('a timeout is JetStream silence, not a timeout from core', async () => {
    const space = await fakeClient(failingWith(new TimeoutError())).client.kv();
    await assert.rejects(
      () => space.get('theme'),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof JikuTimeout) &&
        error.message.includes('nats stream info KV_JIKU_KV') &&
        error.message.includes('$KV.JIKU_KV.dev.{{user_id}}.>'),
    );
  });

  test('a missing bucket at bind is the deployment to fix', async () => {
    const { client } = fakeClient(() =>
      json({ error: { code: 404, err_code: 10059, description: 'stream not found' } }),
    );
    await assert.rejects(
      () => client.kv(),
      (error: unknown) => error instanceof JikuNoBucket && error.message.includes('does not exist'),
    );
  });

  test('no JetStream at bind says so', async () => {
    const { client } = fakeClient(() => {
      throw new RequestError('', { cause: new NoRespondersError(INFO) });
    });
    await assert.rejects(
      () => client.kv(),
      (error: unknown) => error instanceof JikuNoBucket && /not\s+enabled/.test(error.message),
    );
  });
});

/** The subjects under `pub: allow:` in a permissions message. */
function pubAllowLines(message: string): string[] {
  const lines: string[] = [];
  let inPub = false;
  for (const line of message.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'pub:') {
      inPub = true;
    } else if (trimmed === 'sub:' || trimmed.startsWith('Do NOT')) {
      inPub = false;
    } else if (inPub && trimmed.startsWith('- "')) {
      lines.push(trimmed.slice(3, trimmed.indexOf('"', 3)));
    }
  }
  assert.ok(lines.length > 0, `no pub allow lines in:\n${message}`);
  return lines;
}

/** NATS subject matching: `*` is one whole token, `>` is one or more trailing tokens. */
function matches(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') {
      return s.length > i;
    }
    if (i >= s.length || (p[i] !== '*' && p[i] !== s[i])) {
      return false;
    }
  }
  return p.length === s.length;
}
