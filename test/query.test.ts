import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  anyOf,
  between,
  contains,
  getPayload,
  gt,
  gte,
  hasMore,
  listPayload,
  lt,
  lte,
  not,
  range,
} from '../src/query.ts';

describe('filter builders', () => {
  test('the operator is the shape of the value', () => {
    assert.deepEqual(anyOf('a', 'b'), ['a', 'b']);
    assert.deepEqual(not('cancelado'), { not: 'cancelado' });
    assert.deepEqual(not(['a', 'b']), { not: ['a', 'b'] });
    assert.deepEqual(gte('2026-01-01'), { gte: '2026-01-01' });
    assert.deepEqual(gt(1), { gt: 1 });
    assert.deepEqual(lt(1), { lt: 1 });
    assert.deepEqual(lte(1), { lte: 1 });
    assert.deepEqual(between('a', 'b'), { gte: 'a', lte: 'b' });
    assert.deepEqual(contains('modulo', 'facturacion'), { key: 'modulo', value: 'facturacion' });
  });

  test('a single anyOf value is still an array, which core reads as a one-element IN', () => {
    assert.deepEqual(anyOf('solo'), ['solo']);
  });

  test('range omits the bounds that were not given', () => {
    assert.deepEqual(range({ gte: 1 }), { gte: 1 });
    assert.deepEqual(range({ gt: 1, lte: 9 }), { gt: 1, lte: 9 });
    assert.deepEqual(range({}), {});
  });
});

describe('listPayload', () => {
  test('folds limit and cursor into `page`', () => {
    assert.deepEqual(listPayload({ limit: 20, cursor: 'abc' }), {
      page: { limit: 20, cursor: 'abc' },
    });
  });

  test('omits every lever that was not set, rather than sending empties', () => {
    // An empty `filter: {}` or `sort: []` is a top-level key core would have to interpret. The
    // only honest encoding of "I did not ask for this" is the key being absent.
    assert.deepEqual(listPayload({}), {});
    assert.deepEqual(listPayload({ filter: {}, sort: [], fields: [], include: [] }), {});
    assert.deepEqual(listPayload({ limit: 0 }), {});
  });

  test('mirrors the count tri-state exactly as the wire has it', () => {
    assert.equal(listPayload({}).count, undefined);
    assert.equal(listPayload({ count: true }).count, true);
    assert.equal(listPayload({ count: 'only' }).count, 'only');
  });

  test('carries the filter through untouched', () => {
    const filter = { projectId: 15, state: anyOf('activo'), createdAt: gte('2026-01-01') };
    assert.deepEqual(listPayload({ filter }).filter, filter);
  });
});

describe('getPayload', () => {
  test('always carries the id and nothing it was not given', () => {
    assert.deepEqual(getPayload({ id: 7 }), { id: 7 });
    assert.deepEqual(getPayload({ id: 7, include: ['project'], entityType: 'task' }), {
      id: 7,
      include: ['project'],
      entityType: 'task',
    });
  });
});

describe('hasMore', () => {
  test('is exactly "a cursor came back"', () => {
    // NOT `returned < limit`: the byte budget can cut a page short and still emit a cursor, so a
    // short page does not mean the end of the collection.
    assert.equal(hasMore({ limit: 50, returned: 3, cursor: 'x' }), true);
    assert.equal(hasMore({ limit: 50, returned: 50 }), false);
    assert.equal(hasMore({ limit: 50, returned: 3 }), false);
    assert.equal(hasMore({ limit: 50, returned: 3, cursor: '' }), false);
  });
});
