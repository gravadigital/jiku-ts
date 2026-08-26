import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decodeReply, failureOf } from '../src/envelope.ts';
import { JikuError, JikuFailure } from '../src/errors.ts';

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

describe('decodeReply', () => {
  test('reads a success envelope', () => {
    const reply = decodeReply(encode({ status: 'success', data: { id: 1 } }), 'tasks.get');
    assert.equal(reply.status, 'success');
    assert.deepEqual(reply.data, { id: 1 });
  });

  test('reads a failure envelope without turning it into an error', () => {
    // request() hands the caller the envelope and lets them decide; query() is what throws.
    const reply = decodeReply(
      encode({ status: 'failure', errorCode: 'invalid_fields', errorDetails: { field: 'f' } }),
      'tasks.list',
    );
    assert.equal(reply.status, 'failure');
    assert.equal(reply.errorCode, 'invalid_fields');
  });

  test('shows the raw bytes when the reply is not an envelope', () => {
    // A parse error on its own sends the reader nowhere. The body is the evidence.
    assert.throws(
      () => decodeReply(encode('<html>502 Bad Gateway</html>'), 'tasks.list'),
      (error: unknown) => {
        assert.ok(error instanceof JikuError);
        assert.match(error.message, /not an envelope/);
        assert.match(error.message, /502 Bad Gateway/);
        return true;
      },
    );
  });

  test('refuses an envelope with no usable status', () => {
    assert.throws(() => decodeReply(encode({ data: 1 }), 'x'), /no usable status/);
    assert.throws(() => decodeReply(encode({ status: 'ok' }), 'x'), /no usable status/);
  });

  test('refuses a JSON array or scalar, which is not an envelope either', () => {
    assert.throws(() => decodeReply(encode([1, 2]), 'x'), /rather than an envelope object/);
    assert.throws(() => decodeReply(encode(7), 'x'), /rather than an envelope object/);
  });

  test('names bytes that are not UTF-8 for what they are', () => {
    assert.throws(() => decodeReply(new Uint8Array([0xff, 0xfe, 0xfd]), 'x'), /not UTF-8/);
  });

  test('truncates a huge body rather than putting it all in the message', () => {
    let thrown: unknown;
    try {
      decodeReply(encode('x'.repeat(5000)), 'x');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    assert.ok(thrown.message.length < 1000, `the message was ${thrown.message.length} chars`);
  });
});

describe('failureOf', () => {
  test('is undefined for a success', () => {
    assert.equal(failureOf({ status: 'success' }, 'x'), undefined);
  });

  test('builds a JikuFailure carrying everything core said', () => {
    const failure = failureOf(
      {
        status: 'failure',
        errorCode: 'task_not_found',
        errorMessage: 'no existe',
        errorDetails: { field: 'id', value: 9 },
      },
      'tasks.get',
    ) as JikuFailure;
    assert.ok(failure instanceof JikuFailure);
    assert.equal(failure.code, 'task_not_found');
    assert.equal(failure.errorMessage, 'no existe');
    assert.equal(failure.method, 'tasks.get');
    assert.equal(failure.details?.value, 9);
  });

  test('survives a failure envelope with no code at all', () => {
    const failure = failureOf({ status: 'failure' }, 'x') as JikuFailure;
    assert.equal(failure.code, '');
    assert.match(failure.message, /failure/);
  });
});
