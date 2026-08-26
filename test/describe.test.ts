import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  assertValidQuery,
  coerce,
  coerceKind,
  fieldNames,
  filterableNames,
  forVariant,
  resourceNames,
  resourceOf,
  sortableNames,
  suggest,
  validateQuery,
  variantNames,
  type Contract,
  type Resource,
} from '../src/describe.ts';
import { JikuInvalidRequest } from '../src/errors.ts';
import { anyOf, not } from '../src/query.ts';

// A REAL meta.describe reply, captured from a running core. Hand-written fixtures test the
// fixture; this one tests the contract.
const contract = JSON.parse(
  readFileSync(new URL('./fixtures/describe.json', import.meta.url), 'utf8'),
) as Contract;

describe('contract decoding', () => {
  test('reads the resources core actually serves', () => {
    const names = resourceNames(contract);
    assert.ok(names.length >= 16, `only ${names.length} resources`);
    for (const expected of ['tasks', 'projects', 'requirements', 'comments']) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  });

  test('suggests a near match for a resource that does not exist', () => {
    assert.throws(
      () => resourceOf(contract, 'task'),
      (error: unknown) => {
        assert.ok(error instanceof JikuInvalidRequest);
        assert.match(error.message, /did you mean "tasks"\?/);
        return true;
      },
    );
  });

  test('names every resource when nothing is close', () => {
    assert.throws(() => resourceOf(contract, 'zzzzzzzz'), /known: activity, attachments/);
  });
});

describe('discriminated resources', () => {
  // `comments`, `activity` and `subscriptions` arrive with base/includable/filterable as null,
  // and the real whitelists live per variant. Reaching into the maps directly makes them look
  // like they have no fields at all.
  const comments = resourceOf(contract, 'comments');

  test('look empty until read through forVariant', () => {
    assert.equal(comments.base, null);
    assert.equal(filterableNames(comments).length, 0);
    assert.deepEqual(variantNames(comments), ['requirement', 'task']);
    assert.equal(comments.discriminator?.field, 'entityType');
  });

  test('come back with their real whitelists once a variant is resolved', () => {
    const task = forVariant(comments, 'task');
    assert.ok(fieldNames(task).includes('body'), fieldNames(task).join(', '));
    assert.ok(filterableNames(task).includes('entityId'));
    // sortable and defaults stay at the resource level, not on the variant.
    assert.deepEqual(sortableNames(task), sortableNames(comments));
    assert.equal(task.defaults, comments.defaults);
  });

  test('leave an undiscriminated resource untouched', () => {
    const tasks = resourceOf(contract, 'tasks');
    assert.equal(forVariant(tasks, 'anything'), tasks);
    assert.equal(forVariant(tasks), tasks);
  });

  // Today every variant of every discriminated resource happens to declare the same names, so
  // the live contract cannot tell "one variant" apart from "the union". This synthetic one can,
  // and it is the behaviour that has to hold when they diverge.
  const split: Resource = {
    base: null,
    filterable: null,
    sortable: ['id'],
    defaults: { sort: ['id'], limit: 50, maxLimit: 200 },
    discriminator: { field: 'entityType', values: ['task', 'requirement'] },
    variants: {
      task: { filterable: { taskId: { kind: 'integer' } }, base: { title: { kind: 'string' } } },
      requirement: {
        filterable: { requirementId: { kind: 'integer' } },
        base: { summary: { kind: 'string' } },
      },
    },
  };

  test("yield one variant's names when it is named", () => {
    assert.deepEqual(filterableNames(forVariant(split, 'task')), ['taskId']);
    assert.deepEqual(fieldNames(forVariant(split, 'task')), ['title']);
  });

  test('yield the UNION of every variant when none is named', () => {
    // Deliberate: validation must never reject what the server would accept, and without a
    // variant chosen there is no way to know which one applies. The permissive answer is the
    // only correct one.
    assert.deepEqual(filterableNames(forVariant(split)), ['requirementId', 'taskId']);
    assert.deepEqual(validateQuery(forVariant(split), { filter: { taskId: 1 } }), []);
    assert.deepEqual(validateQuery(forVariant(split), { filter: { requirementId: 1 } }), []);
  });

  test('leave an unknown variant to the server rather than inventing a rule', () => {
    assert.deepEqual(filterableNames(forVariant(split, 'nope')), []);
  });
});

describe('validateQuery', () => {
  const tasks = resourceOf(contract, 'tasks');

  test('passes a query core would accept', () => {
    assert.deepEqual(
      validateQuery(tasks, {
        filter: { projectId: 15, state: anyOf('activo') },
        sort: ['-createdAt'],
        include: ['project'],
      }),
      [],
    );
  });

  test('flags an undeclared name and offers the alternatives', () => {
    const problems = validateQuery(tasks, { filter: { projectid: 1 } });
    assert.equal(problems.length, 1);
    assert.match(problems[0] as string, /unknown filter "projectid"/);
    assert.match(problems[0] as string, /did you mean "projectId"\?/);
    assert.match(problems[0] as string, /allowed: area, createdAt/);
  });

  test('checks a sort with its leading minus stripped', () => {
    assert.deepEqual(validateQuery(tasks, { sort: ['-createdAt'] }), []);
    assert.equal(validateQuery(tasks, { sort: ['-nope'] }).length, 1);
  });

  test('checks enum VALUES, not only names', () => {
    // A typo in a state is at least as common as a typo in a field name, and the allowed list
    // is right here.
    const problems = validateQuery(tasks, { filter: { state: 'inventado' } });
    assert.equal(problems.length, 1);
    assert.match(problems[0] as string, /does not accept "inventado"/);
  });

  test('reads enum values through IN and negation too', () => {
    assert.equal(validateQuery(tasks, { filter: { state: anyOf('inventado') } }).length, 1);
    assert.equal(validateQuery(tasks, { filter: { state: not('inventado') } }).length, 1);
  });

  test('says nothing about a range or containment shape on an enum', () => {
    // An enum is not ordered and does not contain, so there is no value to check.
    assert.deepEqual(validateQuery(tasks, { filter: { state: { gte: 'a' } } }), []);
  });

  test('assertValidQuery throws with every problem at once', () => {
    assert.throws(
      () => {
        assertValidQuery(tasks, { filter: { nope: 1 }, sort: ['alsoNope'] });
      },
      (error: unknown) => {
        assert.ok(error instanceof JikuInvalidRequest);
        assert.match(error.message, /unknown filter "nope"/);
        assert.match(error.message, /unknown sort "alsoNope"/);
        return true;
      },
    );
  });
});

describe('coerce', () => {
  const tasks = resourceOf(contract, 'tasks');

  test('types a value from the kind the contract declares', () => {
    assert.equal(coerce(tasks, 'id', '15'), 15);
    assert.equal(coerce(tasks, 'createdBy', '15'), '15');
  });

  test("leaves an undeclared name alone, because naming it is validateQuery's job", () => {
    assert.equal(coerce(tasks, 'nope', '15'), '15');
  });

  test('refuses a value that is not what the kind says', () => {
    // Number(), not parseInt(): parseInt("15abc") is 15, which would send a filter nobody wrote.
    assert.throws(() => coerceKind('integer', '15abc'), /not an integer/);
    assert.throws(() => coerceKind('integer', '1.5'), /not an integer/);
    assert.throws(() => coerceKind('integer', ''), /not an integer/);
    assert.throws(() => coerceKind('number', 'x'), /not a number/);
  });

  test('reads every boolean spelling a human writes', () => {
    for (const yes of ['true', 'TRUE', '1', 'yes']) {
      assert.equal(coerceKind('boolean', yes), true, yes);
    }
    for (const no of ['false', '0', 'no']) {
      assert.equal(coerceKind('boolean', no), false, no);
    }
  });

  test('does not reformat a date', () => {
    // Core accepts what its schema accepts; reformatting risks changing a value the caller
    // wrote deliberately.
    assert.equal(coerceKind('date', '2026-01-01T00:00:00-03:00'), '2026-01-01T00:00:00-03:00');
  });
});

describe('suggest', () => {
  test('names a near miss and stays quiet about a far one', () => {
    assert.equal(suggest('projectid', ['projectId', 'id']), 'projectId');
    assert.equal(suggest('taks', ['tasks', 'projects']), 'tasks');
    assert.equal(suggest('zzzzzzzzzz', ['tasks', 'projects']), undefined);
  });
});
