import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Resource } from '../src/describe.ts';
import { JikuInvalidRequest } from '../src/errors.ts';
import { parseFilter } from '../src/filter.ts';

const resource: Resource = {
  filterable: {
    projectId: { kind: 'integer' },
    code: { kind: 'string' },
    done: { kind: 'boolean' },
    createdAt: { kind: 'date' },
    state: { kind: 'enum', enum: 'state' },
    tag: { kind: 'string', contains: { shape: ['key', 'value'] } },
  },
  defaults: { sort: [], limit: 50, maxLimit: 200 },
};

describe('parseFilter', () => {
  test('picks the operator from the expression', () => {
    assert.deepEqual(parseFilter(['projectId=15'], resource), { projectId: 15 });
    assert.deepEqual(parseFilter(['state=a,b']), { state: ['a', 'b'] });
    assert.deepEqual(parseFilter(['state!=cancelado']), { state: { not: 'cancelado' } });
    assert.deepEqual(parseFilter(['createdAt>=2026-01-01']), {
      createdAt: { gte: '2026-01-01' },
    });
    assert.deepEqual(parseFilter(['tag:modulo=facturacion']), {
      tag: { key: 'modulo', value: 'facturacion' },
    });
  });

  test('types values from the contract, because 15 and "15" are different requests', () => {
    assert.deepEqual(parseFilter(['projectId=15'], resource), { projectId: 15 });
    // A string column whose values happen to be digits must NOT become a number.
    assert.deepEqual(parseFilter(['code=15'], resource), { code: '15' });
    assert.deepEqual(parseFilter(['done=yes'], resource), { done: true });
    assert.deepEqual(parseFilter(['projectId=1,2'], resource), { projectId: [1, 2] });
  });

  test('sends everything as a string when no contract is given', () => {
    assert.deepEqual(parseFilter(['projectId=15']), { projectId: '15' });
  });

  test('merges the two halves of a range window', () => {
    assert.deepEqual(parseFilter(['createdAt>=2026-01-01', 'createdAt<2026-07-01']), {
      createdAt: { gte: '2026-01-01', lt: '2026-07-01' },
    });
  });

  test('refuses a repeat that is not a range, rather than overwriting in silence', () => {
    assert.throws(() => parseFilter(['a=1', 'a=2']), JikuInvalidRequest);
    assert.throws(() => parseFilter(['a>=1', 'a>=2']), JikuInvalidRequest);
    assert.throws(() => parseFilter(['a=1', 'a>=2']), JikuInvalidRequest);
  });

  test('splits on the FIRST operator, so a value may contain one', () => {
    // Searching by operator instead of by position would find the `>=` and produce the field
    // name "title=a".
    assert.deepEqual(parseFilter(['title=a>=b']), { title: 'a>=b' });
  });

  test('names what is wrong with an expression it cannot read', () => {
    assert.throws(() => parseFilter(['nonsense']), /not a filter expression/);
    assert.throws(() => parseFilter(['=value']), /no field name/);
    assert.throws(() => parseFilter(['name=']), /no value/);
    assert.throws(() => parseFilter(['tag:k>=v']), /only supports/);
  });

  test('rejects a value the contract cannot type', () => {
    assert.throws(() => parseFilter(['projectId=abc'], resource), /not an integer/);
    assert.throws(() => parseFilter(['done=maybe'], resource), /not a boolean/);
  });
});
