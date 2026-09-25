import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  ErrorCode,
  JikuError,
  JikuFailure,
  JikuInvalidRequest,
  JikuNoEndpoint,
  JikuPermissionDenied,
  JikuTimeout,
  isCode,
  isJikuError,
} from '../src/errors.ts';

describe('error classes', () => {
  test('every one of ours is a JikuError with its own name', () => {
    const errors = [
      new JikuInvalidRequest('x'),
      new JikuTimeout('x'),
      new JikuNoEndpoint('x'),
      new JikuPermissionDenied('x', 'subj', 'method'),
      new JikuFailure({ code: 'task_not_found' }),
    ];
    for (const error of errors) {
      assert.ok(error instanceof JikuError, error.constructor.name);
      assert.ok(error instanceof Error);
      assert.equal(error.name, error.constructor.name);
    }
  });

  test('chains a cause, so the transport error is never lost', () => {
    const cause = new Error('socket closed');
    assert.equal(new JikuError('wrapper', { cause }).cause, cause);
  });

  test('isJikuError survives a second copy of the package', () => {
    // The brand is a Symbol.for, which is registry-global. `instanceof` compares constructor
    // identity and would quietly stop working across two installs of this package.
    const foreign = { [Symbol.for('gravadigital.jiku.error')]: true };
    assert.ok(isJikuError(foreign));
    assert.ok(isJikuError(new JikuTimeout('x')));
    assert.ok(!isJikuError(new Error('x')));
    assert.ok(!isJikuError(undefined));
    assert.ok(!isJikuError(null));
  });

  test('JikuPermissionDenied carries the subject the bus refused', () => {
    const error = new JikuPermissionDenied('refused', 'dev.1.jiku-commands.v1.x.new', 'x.new');
    assert.equal(error.subject, 'dev.1.jiku-commands.v1.x.new');
    assert.equal(error.method, 'x.new');
  });
});

describe('JikuFailure', () => {
  test('renders the code, the message and the structured details', () => {
    const error = new JikuFailure({
      code: ErrorCode.InvalidFields,
      errorMessage: 'El filtro no existe',
      details: { field: 'filter', value: 'nope', allowed: ['id', 'projectId'] },
      method: 'tasks.list',
    });
    assert.match(error.message, /tasks\.list: invalid_fields: El filtro no existe/);
    assert.match(error.message, /\(field "filter" = nope\)/);
    assert.match(error.message, /allowed: id, projectId/);
  });

  test('sorts `allowed` so two runs of the same failure read the same', () => {
    const error = new JikuFailure({ code: 'x', details: { allowed: ['z', 'a', 'm'] } });
    assert.match(error.message, /allowed: a, m, z/);
  });

  test('is readable with nothing but a code', () => {
    assert.equal(new JikuFailure({ code: 'task_not_found' }).message, 'jiku: task_not_found');
  });

  test('keeps the details core sent, verbatim and unparsed', () => {
    // A caller must never have to regex the message. Unknown keys survive too, so a field core
    // starts sending tomorrow is not lost.
    const error = new JikuFailure({
      code: 'x',
      details: { field: 'a', allowed: ['b'], somethingNew: 42 },
    });
    assert.equal(error.details?.somethingNew, 42);
  });
});

describe('isCode', () => {
  test('matches a failure by its code', () => {
    const error = new JikuFailure({ code: ErrorCode.TaskNotFound });
    assert.ok(isCode(error, ErrorCode.TaskNotFound));
    assert.ok(isCode(error, 'task_not_found'));
    assert.ok(!isCode(error, ErrorCode.ProjectNotFound));
  });

  test('is false for anything that is not a failure', () => {
    assert.ok(!isCode(new JikuTimeout('x'), ErrorCode.TaskNotFound));
    assert.ok(!isCode(new Error('x'), ErrorCode.TaskNotFound));
    assert.ok(!isCode(undefined, ErrorCode.TaskNotFound));
  });

  test('works for a code this library has never heard of', () => {
    // The catalog is core's and it grows. An unrecognised code must still arrive intact.
    const error = new JikuFailure({ code: 'invented_next_year' });
    assert.ok(isCode(error, 'invented_next_year'));
    assert.equal(error.hint(), undefined);
  });
});

describe('hints', () => {
  test('explain the codes whose name does not explain the cause', () => {
    for (const code of [
      ErrorCode.CallerNotAuthorized,
      ErrorCode.UnknownCaller,
      ErrorCode.UnknownCommand,
      ErrorCode.InvalidCursor,
      ErrorCode.QueryTimeout,
      ErrorCode.InvalidFields,
    ]) {
      const hint = new JikuFailure({ code }).hint();
      assert.ok(hint && hint.length > 20, `no hint for ${code}`);
    }
  });

  test('stay quiet for the codes that speak for themselves', () => {
    assert.equal(new JikuFailure({ code: ErrorCode.TaskNotFound }).hint(), undefined);
    assert.equal(new JikuFailure({ code: ErrorCode.FileTooLarge }).hint(), undefined);
  });

  test('caller_not_authorized names all three causes, because the code cannot tell them apart', () => {
    const hint = new JikuFailure({ code: ErrorCode.CallerNotAuthorized }).hint() as string;
    assert.match(hint, /role/);
    assert.match(hint, /users` table/);
    assert.match(hint, /race/);
  });
});

describe('the error catalog against jiku-go', () => {
  // The catalog is core's, and this client inherits it through jiku-go. CI here has no access
  // to that repository — deliberately, the same rule jiku-go applies to Jiku — so the snapshot
  // is a fixture, extracted with a script during a sync and never transcribed by hand.
  //
  // BOTH DIRECTIONS MATTER. Checking only "jiku-go has it, we lack it" lets the list grow
  // forever and never shrink, which is how a retired code goes unnoticed; jiku-go's own
  // catalog test had exactly that hole for a full release and carried a phantom duplicate
  // because of it.
  const snapshot = JSON.parse(
    readFileSync(new URL('./fixtures/error-codes.json', import.meta.url), 'utf8'),
  ) as { codes: string[] };

  const ours = new Set<string>(Object.values(ErrorCode));
  const theirs = new Set(snapshot.codes);

  test('every code jiku-go declares has a constant here', () => {
    const missing = [...theirs].filter((code) => !ours.has(code)).sort();
    assert.deepEqual(
      missing,
      [],
      `jiku-go declares these and this client does not: ${missing.join(', ')}`,
    );
  });

  test('every constant here is a code jiku-go declares', () => {
    // A code that loses its EMITTER keeps its constant — core keeps it too. What this catches
    // is a code that left the catalog entirely, or one invented here.
    const extra = [...ours].filter((code) => !theirs.has(code)).sort();
    assert.deepEqual(
      extra,
      [],
      `this client declares these and jiku-go does not: ${extra.join(', ')}`,
    );
  });

  test('the codes with no current emitter are still carried', () => {
    // REQ-012 took invalid_state_transition's emitter away; file_not_available and
    // invalid_attachment_id never had one here. Deleting them is the tempting wrong move.
    for (const code of [
      'invalid_state_transition',
      'file_not_available',
      'invalid_attachment_id',
    ]) {
      assert.ok(
        ours.has(code),
        `${code} was dropped; a code that loses its emitter keeps its constant`,
      );
    }
  });
});
