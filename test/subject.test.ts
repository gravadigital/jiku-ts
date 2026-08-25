import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';

import {
  FORBIDDEN_COMMAND_FIELDS,
  FORBIDDEN_QUERY_IDENTITY_FIELDS,
  PROTOCOL_VERSION,
  SERVICE_COMMANDS,
  SERVICE_QUERIES,
  hashUserId,
  inboxPrefix,
  splitMethod,
  subject,
} from '../src/subject.ts';

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/inbox-vectors.json', import.meta.url), 'utf8'),
) as {
  vectors: { userId: string; hash: string; note: string }[];
  shapeInputs: string[];
};

describe('inbox hash', () => {
  // These are the values a RUNNING auth-callout minted permissions for. If this test fails,
  // every request made by this client times out with no error the caller can see.
  for (const { userId, hash, note } of vectors.vectors) {
    test(`matches the callout for ${userId} (${note})`, async () => {
      assert.equal(await hashUserId(userId), hash);
      assert.equal(await inboxPrefix(userId), `_INBOX.${hash}`);
    });
  }

  test('has the shape the subject grammar depends on', async () => {
    for (const input of vectors.shapeInputs) {
      const hash = await hashUserId(input);
      assert.equal(hash.length, 16, `${JSON.stringify(input)} hashed to ${hash.length} chars`);
      for (const bad of ['.', '*', '>', '=']) {
        assert.ok(!hash.includes(bad), `${hash} contains ${bad}, which breaks a subject token`);
      }
      assert.equal(hash, hash.toLowerCase());
    }
  });

  test('is spread out enough not to collide', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(await hashUserId(`27564906380892${i}`));
    }
    assert.equal(seen.size, 500);
  });
});

describe('subject grammar', () => {
  test('builds the five-token subject core subscribes to', () => {
    assert.equal(
      subject('dev', '275649063808925701', SERVICE_QUERIES, 'tasks.list'),
      'dev.275649063808925701.jiku-queries.v1.tasks.list',
    );
    assert.equal(
      subject('prod', '999', SERVICE_COMMANDS, 'requirements.7.edit'),
      'prod.999.jiku-commands.v1.requirements.7.edit',
    );
  });

  test('keeps the two planes on separate service tokens', () => {
    // Not cosmetic: the command subscription ends in `>` and would swallow the queries if they
    // shared this token, delivering each message to both queue groups.
    assert.notEqual(SERVICE_QUERIES, SERVICE_COMMANDS);
    assert.equal(PROTOCOL_VERSION, 'v1');
  });
});

describe('splitMethod', () => {
  test('splits a resource from its operation', () => {
    assert.deepEqual(splitMethod('tasks.list'), { resource: 'tasks', operation: 'list' });
    assert.deepEqual(splitMethod('requirements.7.subscriptors.new'), {
      resource: 'requirements.7.subscriptors',
      operation: 'new',
    });
  });

  test('refuses what is not a method rather than inventing a half', () => {
    for (const input of ['', 'tasks', '.list', 'tasks.']) {
      assert.equal(splitMethod(input), null, JSON.stringify(input));
    }
  });
});

describe('forbidden field lists', () => {
  test('the two planes do not share one list', () => {
    // Applying the read plane's list to writes rejects legitimate commands: several take a
    // `userId` as domain data (who is being subscribed), not as a claim about who is calling.
    assert.ok(FORBIDDEN_QUERY_IDENTITY_FIELDS.includes('userId'));
    assert.ok(!FORBIDDEN_COMMAND_FIELDS.includes('userId'));
    assert.deepEqual([...FORBIDDEN_COMMAND_FIELDS], ['actor']);
  });

  test('actor is forbidden on both planes', () => {
    assert.ok(FORBIDDEN_QUERY_IDENTITY_FIELDS.includes('actor'));
    assert.ok(FORBIDDEN_COMMAND_FIELDS.includes('actor'));
  });
});
