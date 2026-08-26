/**
 * jiku-ts in a browser.
 *
 * Bundle this with anything that understands package `exports` conditions:
 *
 * ```sh
 * npx esbuild examples/browser/main.js --bundle --format=esm --outfile=examples/browser/bundle.js
 * ```
 *
 * The bundler matches the `default` export condition, not `node`, so what it pulls in is the
 * WebSocket-only build of this package — no `node:net`, no `node:fs`, nothing to polyfill.
 * Measured with esbuild: 164 KB minified, 49 KB gzipped, almost all of it the NATS client.
 */
import { ErrorCode, anyOf, connect, isCode } from '@gravadigital/jiku';
import { tokenGetter } from '@gravadigital/jiku/auth';

/**
 * The sentinel NATS creds, as the CONTENTS of the file.
 *
 * SHIPPING THIS TO A BROWSER IS SAFE, AND IT IS SAFE BY CONSTRUCTION RATHER THAN BY CONVENTION.
 * The file's own JWT carries `pub.deny: [">"]` and `sub.deny: [">"]` — it authorises literally
 * nothing. It exists only so the connection can reach the auth-callout, which is what mints real
 * permissions, and it mints them from the Zitadel token below. That token is the credential that
 * matters, and it belongs to the person using the page.
 *
 * A SERVICE-ACCOUNT KEY IS THE OPPOSITE AND MUST NEVER APPEAR HERE. It is a private key that
 * mints tokens for a machine identity, with no user behind it. That is why `ServiceUser` lives in
 * `@gravadigital/jiku/node` and cannot be imported into a browser bundle at all.
 */
const SENTINEL_CREDS = `-----BEGIN NATS USER JWT-----
...paste the contents of sentinel-client.creds here, or fetch it at runtime...
------END NATS USER JWT------`;

const out = document.getElementById('out');
const log = (line) => {
  out.textContent += `\n${line}`;
};

/**
 * Returns the access token this page's user already has.
 *
 * A real page gets this from Zitadel's web SDK, from an authorization-code + PKCE flow, or from
 * a session its own backend owns. This library does not authenticate anybody in a browser: by
 * the time you are here, that has happened.
 *
 * There is deliberately no token store in the browser build — a refresh token in `localStorage`
 * is readable by every script on the origin, and the application owns its session, not us.
 */
function getToken() {
  const token = sessionStorage.getItem('zitadel_access_token');
  if (!token) {
    throw new Error('no access token — log in first');
  }
  // The callback may be sync or async; a real one that has to refresh returns a promise.
  return token;
}

try {
  out.textContent = 'connecting…';

  const client = await connect({
    // wss://, not nats:// — a browser cannot open a raw TCP socket, and this entry point says
    // so with a real error rather than a bundling failure.
    servers: 'wss://bus.example.com:8443',
    instance: 'prod',
    creds: SENTINEL_CREDS,
    // The callback is cached until a minute before the token expires, so it is not called on
    // every reconnect.
    auth: tokenGetter({ getToken }),
  });

  log(`connected to ${client.connectedUrl}`);
  log(`identity     ${client.userId}`);
  log(`inbox        ${client.inboxPrefix}`);
  log('');

  const page = await client.list('tasks', {
    filter: { state: anyOf('analisis', 'activo') },
    sort: ['-createdAt'],
    limit: 10,
  });

  log(`${page.page.returned} tasks:`);
  for (const task of page.items) {
    log(`  ${task.id}  ${task.title}`);
  }

  // Writes are not available to a person's token: the product roles authorise every query and no
  // command, by the bus template AND by core's role map. A browser that needs to write goes
  // through the api over HTTP.
  try {
    await client.command('tasks.new', { title: 'from a browser' });
  } catch (error) {
    log(`\nas expected, the write plane is closed: ${error.constructor.name}`);
  }

  await client.close();
} catch (error) {
  if (isCode(error, ErrorCode.CallerNotAuthorized)) {
    log('\nyour role authorises nothing on this bus');
  }
  log(`\n${error.message}`);
}
