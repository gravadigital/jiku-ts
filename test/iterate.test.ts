import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Client } from '../src/client.ts';
import type { Collection, ListQuery } from '../src/query.ts';

/**
 * The page sequence is driven by replacing `list`, not by standing up a bus.
 *
 * The shape this file exists to pin — an EMPTY page that still carries a cursor — depends on
 * where the byte budget falls, and a live server cannot be made to produce one on demand. It
 * is therefore unreachable from the integration suite, which is exactly why jiku-go's
 * equivalent defect survived: its `Iterator` had no tests at all.
 *
 * `list` is public and `iterate`/`iteratePages`/`all` all go through it, so the seam needs no
 * production code to exist for testing's sake.
 */
function clientOver<T>(pages: Collection<T>[]): { client: Client; queries: ListQuery[] } {
  // Nothing here touches the connection: every test path stops at the replaced `list`.
  const client = Client.fromConnection({} as never, { userId: '123456789012345678' });
  const queries: ListQuery[] = [];
  let next = 0;
  (client as { list: unknown }).list = (
    _resource: string,
    query: ListQuery = {},
  ): Promise<Collection<T>> => {
    queries.push(query);
    const page = pages[next++];
    assert.ok(page, 'iterate asked for more pages than the test provided');
    return Promise.resolve(page);
  };
  return { client, queries };
}

const page = <T>(items: T[], cursor?: string): Collection<T> => ({
  items,
  // `returned` is what core reports, so it tracks items.length — the point of these tests is
  // that neither it nor items.length is the end-of-collection signal.
  page: { limit: 50, returned: items.length, ...(cursor === undefined ? {} : { cursor }) },
});

describe('iterate ends only on a missing cursor', () => {
  test('an EMPTY page carrying a cursor is a continuation, not the end', async () => {
    // THE DEFECT THIS PINS. The byte budget (max_payload x 0.5) cuts a page wherever the reply
    // would exceed what NATS accepts and emits a cursor at the cut, so a page can come back
    // with no items and still mean "keep going". Stopping there truncates the sweep silently:
    // a short collection, no error, and nothing to tell it apart from a genuinely small one.
    const { client } = clientOver([
      page([1], 'c1'),
      page<number>([], 'c2'),
      page([2, 3], 'c3'),
      page([4]),
    ]);

    assert.deepEqual(await client.all<number>('tasks'), [1, 2, 3, 4]);
  });

  test('a SHORT page carrying a cursor is a continuation too', async () => {
    const { client } = clientOver([page([1], 'c1'), page([2, 3])]);
    assert.deepEqual(await client.all<number>('tasks'), [1, 2, 3]);
  });

  test('a full page with no cursor is the end', async () => {
    const { client } = clientOver([page([1, 2, 3])]);
    assert.deepEqual(await client.all<number>('tasks'), [1, 2, 3]);
  });

  test('an empty cursor string ends the walk rather than looping forever', async () => {
    // `hasMore` requires a non-empty string. A server that sends `cursor: ""` must not put this
    // into an endless loop asking for the same page.
    const { client } = clientOver([page([1], '')]);
    assert.deepEqual(await client.all<number>('tasks'), [1]);
  });

  test('each page after the first carries the previous page cursor', async () => {
    const { client, queries } = clientOver([page([1], 'c1'), page<number>([], 'c2'), page([2])]);
    await client.all<number>('tasks', { limit: 10 });

    assert.deepEqual(
      queries.map((q) => q.cursor),
      [undefined, 'c1', 'c2'],
    );
    // The rest of the query survives every page: a filter dropped on page two would silently
    // widen the sweep.
    assert.deepEqual(
      queries.map((q) => q.limit),
      [10, 10, 10],
    );
  });

  test('iteratePages hands back the empty page rather than swallowing it', async () => {
    // A caller storing a cursor for later needs the page that carried it, even with no items.
    const { client } = clientOver([page([1], 'c1'), page<number>([], 'c2'), page([2])]);
    const seen: number[][] = [];
    for await (const p of client.iteratePages<number>('tasks')) {
      seen.push(p.items);
    }
    assert.deepEqual(seen, [[1], [], [2]]);
  });

  test('nothing is requested until the first iteration', async () => {
    const { client, queries } = clientOver([page([1])]);
    const iterator = client.iterate<number>('tasks');
    assert.equal(queries.length, 0);
    await iterator.next();
    assert.equal(queries.length, 1);
  });
});
