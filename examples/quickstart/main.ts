/**
 * The shortest useful program: log in, read, paginate, handle a failure.
 *
 * It authenticates a PERSON through the device flow — you approve it once in a browser and the
 * session is kept in `~/.config/jiku/tokens-<instance>.json`, so later runs are silent.
 *
 * ```sh
 * node --experimental-strip-types examples/quickstart/main.ts
 * ```
 */
import { ErrorCode, anyOf, connect, gte, isCode, type JikuFailure } from '@gravadigital/jiku';
import { DeviceFlow, LoginRequired } from '@gravadigital/jiku/auth';
import { FileStore, defaultStorePath, loadConfig } from '@gravadigital/jiku/node';

/** Only the fields this program asks for. The reply's shape follows `fields` and `include`. */
interface Project {
  id: number;
  name: string;
  status: string;
  createdAt: string;
}

const config = await loadConfig();
if (!config.zitadel.clientId) {
  throw new Error('set zitadel.client_id in ~/.config/jiku/config.yaml, or JIKU_CLIENT_ID');
}

const auth = new DeviceFlow({
  issuer: config.zitadel.issuer,
  clientId: config.zitadel.clientId,
  // Without a project id the token carries no ROLES claim, and a token with no roles connects
  // to nothing. The error you would get says only "Authorization Violation".
  projectId: config.zitadel.projectId,
  store: new FileStore(defaultStorePath(config.instance)),
});

// token() NEVER opens a browser on its own — a call that silently blocks on a human is the kind
// of surprise that takes a service down at 3am. It throws instead, and login() is the one method
// that waits for anybody.
try {
  await auth.token();
} catch (error) {
  if (!(error instanceof LoginRequired)) {
    throw error;
  }
  await auth.login();
}

// `close()` in a finally rather than `await using`: this file is run by Node directly, and the
// explicit-resource-management syntax is a syntax error before Node 24. `Client` does implement
// Symbol.asyncDispose, so `await using` works where the syntax does.
const client = await connect({
  servers: config.servers,
  instance: config.instance,
  credsFile: config.credsFile,
  auth,
});

try {
  await main();
} finally {
  await client.close();
}

async function main(): Promise<void> {
  console.log(`connected to ${client.connectedUrl} as ${client.userId}`);
  console.log(`inbox        ${client.inboxPrefix}\n`);

  // -------------------------------------------------------------- one page

  const page = await client.list<Project>('projects', {
    filter: { status: anyOf('activo'), createdAt: gte('2026-01-01') },
    sort: ['-createdAt'],
    limit: 5,
  });

  console.log(`first page (${page.page.returned} of limit ${page.page.limit}):`);
  for (const project of page.items) {
    console.log(`  ${String(project.id).padStart(4)}  ${project.name}`);
  }

  // The ABSENCE of a cursor is the only end-of-collection signal. A page can come back shorter
  // than the limit because of a byte budget, so `returned < limit` proves nothing.
  console.log(page.page.cursor ? '\n  ...there is more\n' : '\n  ...that was all\n');

  // -------------------------------------------------------------- every page

  let count = 0;
  for await (const _project of client.iterate<Project>('projects', { limit: 50 })) {
    count++;
  }
  console.log(`walked ${count} projects, following every cursor`);

  // `count: 'only'` skips the rows query, so this is one query over the filter's universe.
  console.log(`the server agrees: ${await client.count('projects')}\n`);

  // -------------------------------------------------------------- a failure

  try {
    await client.get<Project>('projects', { id: 999_999_999 });
  } catch (error) {
    if (isCode(error, ErrorCode.ProjectNotFound)) {
      // Deliberately indistinguishable from "you may not see it": telling them apart would
      // confirm to an external caller that the record exists.
      console.log('project 999999999: not found (or not visible to you — the same answer)');
    } else {
      throw error;
    }
  }

  // -------------------------------------------------------------- a mistake

  try {
    await client.list('projects', { filter: { noSuchField: 1 } });
  } catch (error) {
    const failure = error as JikuFailure;
    console.log(`\nrejected: ${failure.code}`);
    console.log(`  allowed: ${failure.details?.allowed?.join(', ')}`);
    console.log(`  hint:    ${failure.hint()?.split('\n')[0]}`);
  }
}
