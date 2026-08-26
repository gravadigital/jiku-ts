/**
 * An unattended service: a machine user, a long-lived connection, and a read loop.
 *
 * This is the shape a real integration takes. The differences from the quickstart are the ones
 * that matter in production:
 *
 *   - the identity is a KEY, not a stored session, so nothing expires that a human has to fix;
 *   - the client is built ONCE and kept, because connecting costs a round trip to Zitadel plus a
 *     NATS handshake that runs the auth-callout;
 *   - the token is refreshed in the background, so a reconnect after an expiry re-authenticates
 *     instead of being refused.
 *
 * ```sh
 * JIKU_KEY_FILE=/etc/jiku/service-account.json \
 *   node --experimental-strip-types examples/service-user/main.ts
 * ```
 */
import {
  ErrorCode,
  JikuPermissionDenied,
  connect,
  isCode,
  isJikuError,
  type JikuFailure,
} from '@gravadigital/jiku';
import { ServiceUser, loadConfig } from '@gravadigital/jiku/node';

interface Task {
  id: number;
  title: string;
  state: string;
}

const config = await loadConfig();
const keyFile = process.env['JIKU_KEY_FILE'] ?? config.zitadel.keyFile;
const issuer = config.zitadel.issuer;
if (!keyFile || !issuer) {
  throw new Error(
    'set JIKU_KEY_FILE and JIKU_ISSUER, or zitadel.key_file and zitadel.issuer in ' +
      '~/.config/jiku/config.yaml',
  );
}

// The key file IS the credential. Zitadel downloads it exactly once; it cannot be
// re-downloaded, only replaced by a new key.
const auth = await ServiceUser.fromKeyFile(keyFile, {
  issuer,
  // Without a project id the token carries no ROLES claim, and a token with no roles connects
  // to nothing. The error you get says only "Authorization Violation".
  projectId: config.zitadel.projectId,
});

console.log(`machine user ${auth.userId}`);

const client = await connect({
  servers: config.servers,
  instance: config.instance,
  credsFile: config.credsFile,
  auth,
  // A background refresh failing is not fatal — the current token still works — but it means the
  // NEXT reconnect will be refused, so it belongs in your logs rather than on the floor.
  onTokenError: (error) => {
    console.error('[jiku] token refresh failed:', error);
  },
});

// One client for the life of the process. Not one per request.
try {
  const contract = await client.contract();
  console.log(`core serves ${Object.keys(contract.resources).length} resources`);
  console.log(`token expires ${auth.expiresAt()?.toISOString() ?? 'unknown'}\n`);

  let scanned = 0;
  for await (const task of client.iterate<Task>('tasks', {
    fields: ['id', 'title', 'state'],
    limit: 100,
  })) {
    scanned++;
    if (scanned <= 3) {
      console.log(`  ${task.id}  ${task.state.padEnd(14)}  ${task.title}`);
    }
  }
  console.log(`\nscanned ${scanned} tasks`);

  // ------------------------------------------------------------ the write plane
  //
  // Three different systems can refuse a command, they are refused for different reasons, and
  // the fix is different in each case. This is what telling them apart looks like.
  //
  // The payload below is deliberately incomplete, so that on a deployment where this identity
  // CAN write, the command is still rejected on its shape and creates nothing. An example that
  // leaves a row behind is not an example.
  try {
    await client.command('clients.new', { deliberatelyIncomplete: true });
    console.log('\nthe command succeeded, which this payload should have made impossible');
  } catch (error) {
    if (error instanceof JikuPermissionDenied) {
      // 1. THE BUS refused, by subject, before core saw anything. Your token's role selected a
      //    permission template that does not grant the command plane. Nothing about core's
      //    authorisation is implied either way.
      console.log(`\nthe BUS refused the publish (${error.subject})`);
    } else if (isCode(error, ErrorCode.CallerNotAuthorized)) {
      // 2. CORE refused, by role. The bus let the message through; core's own role -> method
      //    map does not grant this method to this caller. Different system, different fix.
      console.log('\nthe BUS accepted it and CORE refused it, by role');
      console.log(`  ${(error as JikuFailure).hint()?.split('\n')[0]}`);
    } else if (isCode(error, ErrorCode.InvalidFields)) {
      // 3. CORE accepted the caller and refused the SHAPE — which is what should happen here,
      //    and it proves this identity may publish commands at all.
      console.log('\nthe command plane is open to this identity; the payload was refused:');
      console.log(`  ${(error as JikuFailure).message.split('\n')[0]}`);
    } else if (isJikuError(error)) {
      console.log(`\nrefused: ${error.message.split('\n')[0]}`);
    } else {
      throw error;
    }
  }
} finally {
  await client.close();
}
