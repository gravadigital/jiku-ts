import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { DeviceFlow, type TokenSource } from '../../src/auth/index.ts';
import type { Client } from '../../src/client.ts';
import { ErrorCode, JikuNoEndpoint, JikuPermissionDenied, isCode } from '../../src/errors.ts';
import { assertValidQuery, resourceOf } from '../../src/describe.ts';
import { loadConfig } from '../../src/node/config.ts';
import { FileStore, defaultStorePath } from '../../src/node/store.ts';
import { connect } from '../../src/transport/node.ts';

/**
 * These talk to a REAL Jiku deployment, with a real auth-callout and real core.
 *
 * They are the only tests that can prove the parts no stand-in can fake: that the inbox prefix
 * matches what the callout minted, that the contract this client decodes is the contract core
 * publishes, and that the bus refuses the command plane to a product role. They need
 * credentials, so they never run in CI and they never run by accident:
 *
 * ```sh
 * JIKU_TEST_LIVE=1 npm run test:integration                    # an existing stored session
 * JIKU_KEY_FILE=… JIKU_TEST_LIVE=1 npm run test:integration    # a machine user
 * ```
 *
 * With no stored session and no key file they fail with `LoginRequired`, which is correct: a
 * test suite must never open a browser.
 */
const enabled = process.env['JIKU_TEST_LIVE'] === '1';

describe('a live Jiku bus', { skip: enabled ? false : 'set JIKU_TEST_LIVE=1 to run' }, () => {
  let client: Client;

  before(async () => {
    const config = await loadConfig();
    const auth = await liveAuth(config.instance);
    client = await connect({
      servers: config.servers ?? 'nats://localhost:4222',
      instance: config.instance,
      credsFile: config.credsFile,
      auth,
    });
  });

  after(async () => {
    await client?.close();
  });

  test('the inbox prefix is the one the callout granted', async () => {
    // If this is wrong every request times out and the violation is logged by the NATS server,
    // where nobody looks. It is the single most expensive mistake on this bus.
    assert.match(client.inboxPrefix, /^_INBOX\.[a-z2-7]{16}$/);
    // A request that gets an answer at all proves the reply reached an inbox we subscribe to.
    await client.describe(['projects']);
  });

  test('the contract core publishes is the one this client decodes', async () => {
    const contract = await client.contract();
    const tasks = resourceOf(contract, 'tasks');
    assert.ok(Object.keys(tasks.filterable ?? {}).length > 0);
    assert.ok((tasks.sortable ?? []).length > 0);
    assert.ok(tasks.defaults.maxLimit > 0);

    // Validating against the live contract must accept what the live server accepts.
    assertValidQuery(tasks, { filter: { projectId: 1 }, sort: ['-createdAt'], limit: 1 });
    await client.list('tasks', { filter: { projectId: 1 }, sort: ['-createdAt'], limit: 1 });
  });

  test('the server agrees with us about what does not exist', async () => {
    // The local validator and core's must reject the same name, or one of them is wrong.
    const tasks = await client.resource('tasks');
    assert.throws(() => {
      assertValidQuery(tasks, { filter: { noSuchField: 1 } });
    });
    await assert.rejects(
      () => client.list('tasks', { filter: { noSuchField: 1 } }),
      (error: unknown) => {
        assert.ok(isCode(error, ErrorCode.InvalidFields));
        return true;
      },
    );
  });

  test('pagination reaches the same total two different ways', async () => {
    const total = await client.count('projects');
    const walked = await client.all('projects', { limit: 2 });
    assert.equal(walked.length, total);
  });

  test('a method core does not register answers at once', async () => {
    await assert.rejects(
      () => client.query('tasks.noSuchOperation'),
      (error: unknown) => {
        assert.ok(error instanceof JikuNoEndpoint || isCode(error, ErrorCode.UnknownCommand));
        return true;
      },
    );
  });

  test('the bus refuses the command plane, and says so in milliseconds', async () => {
    // A publish violation is asynchronous: without the client catching it, this would cost the
    // whole timeout and then report "nothing replied".
    const started = Date.now();
    await assert.rejects(
      () => client.command('clients.new', { name: 'from a test, never delivered' }),
      (error: unknown) => {
        assert.ok(error instanceof JikuPermissionDenied, String(error));
        assert.match(error.subject, /jiku-commands/);
        assert.ok(
          Date.now() - started < 2000,
          `took ${Date.now() - started}ms; the refusal should be immediate`,
        );
        return true;
      },
    );
  });
});

/**
 * Uses whatever identity the machine already has: a service-account key if one is configured,
 * otherwise a stored session.
 *
 * DeviceFlow reads the store and refreshes; it never opens a browser on its own, so with nothing
 * stored this throws instead of hanging a test run on a human.
 */
async function liveAuth(instance: string): Promise<TokenSource> {
  const config = await loadConfig();
  const keyFile = process.env['JIKU_KEY_FILE'] ?? config.zitadel.keyFile;

  if (keyFile) {
    const { ServiceUser } = await import('../../src/node/service-user.ts');
    return ServiceUser.fromKeyFile(keyFile, {
      issuer: config.zitadel.issuer,
      projectId: config.zitadel.projectId,
    });
  }

  if (!config.zitadel.clientId) {
    throw new Error('set JIKU_KEY_FILE, or zitadel.client_id for a stored session');
  }
  return new DeviceFlow({
    issuer: config.zitadel.issuer,
    clientId: config.zitadel.clientId,
    projectId: config.zitadel.projectId,
    store: new FileStore(defaultStorePath(instance)),
  });
}
