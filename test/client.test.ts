import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { checkNoIdentityFields, encodePayload } from '../src/client.ts';
import { JikuInvalidRequest } from '../src/errors.ts';
import { SERVICE_COMMANDS, SERVICE_QUERIES } from '../src/subject.ts';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('encodePayload', () => {
  test('sends {} rather than an empty body when there is nothing to send', () => {
    // Several endpoints take no arguments, and an empty body is not valid JSON for a validator
    // that expects an object.
    assert.equal(decode(encodePayload(SERVICE_QUERIES)), '{}');
    assert.equal(decode(encodePayload(SERVICE_QUERIES, null)), '{}');
    assert.equal(decode(encodePayload(SERVICE_QUERIES, '  ')), '{}');
  });

  test('passes a raw JSON string through untouched', () => {
    assert.equal(decode(encodePayload(SERVICE_QUERIES, '{"a":1}')), '{"a":1}');
  });

  test('encodes an object', () => {
    assert.equal(decode(encodePayload(SERVICE_QUERIES, { a: 1 })), '{"a":1}');
  });

  test('refuses a payload that is not a JSON object', () => {
    assert.throws(() => encodePayload(SERVICE_QUERIES, '[1,2]'), /not a JSON object/);
    assert.throws(() => encodePayload(SERVICE_QUERIES, 'not json'), /not valid JSON/);
  });
});

describe('forbidden identity fields', () => {
  test('the read plane rejects a caller claim before it costs a round trip', () => {
    for (const name of ['userId', 'sub', 'actor', 'onBehalfOf', 'caller']) {
      assert.throws(
        () => encodePayload(SERVICE_QUERIES, { [name]: 1 }),
        (error: unknown) => {
          assert.ok(error instanceof JikuInvalidRequest);
          assert.match(error.message, /forbidden identity field/);
          return true;
        },
        name,
      );
    }
  });

  test('the write plane rejects only `actor`', () => {
    // Applying the read plane's list here would make `requirements.{id}.subscriptors.new`
    // impossible to send. Refusing what the server accepts is the exact failure this library
    // exists to prevent, so the two lists are deliberately different.
    assert.throws(() => encodePayload(SERVICE_COMMANDS, { actor: 'x' }), /reserved identity/);
    for (const name of ['userId', 'personId', 'creator', 'editor', 'author', 'uploader']) {
      assert.doesNotThrow(() => encodePayload(SERVICE_COMMANDS, { [name]: 1 }), name);
    }
  });

  test('only TOP-LEVEL keys are identity claims', () => {
    // `subscriptions` genuinely declares `userId` as a filterable, so {filter: {userId}} is a
    // legitimate read. The rule is about the envelope, not about every nested key.
    assert.doesNotThrow(() => encodePayload(SERVICE_QUERIES, { filter: { userId: 5 } }));
    assert.doesNotThrow(() => encodePayload(SERVICE_QUERIES, { filter: { sub: 'x' } }));
  });

  test('checks a raw JSON string and raw bytes too, not just objects', () => {
    assert.throws(() => encodePayload(SERVICE_QUERIES, '{"userId":1}'), /forbidden identity/);
    assert.throws(
      () => encodePayload(SERVICE_QUERIES, new TextEncoder().encode('{"userId":1}')),
      /forbidden identity/,
    );
  });

  test('checkNoIdentityFields is exported for callers building their own payloads', () => {
    assert.doesNotThrow(() => {
      checkNoIdentityFields(SERVICE_QUERIES, { filter: {} });
    });
    assert.throws(() => {
      checkNoIdentityFields(SERVICE_QUERIES, { userId: 1 });
    });
  });
});
