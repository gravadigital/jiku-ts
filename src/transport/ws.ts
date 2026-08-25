import { wsconnect, type ConnectionOptions } from '@nats-io/nats-core';

import type { Client } from '../client.ts';
import { parseServers, transportOf, type ConnectOptions } from '../config.ts';
import { JikuInvalidRequest } from '../errors.ts';
import { connectWith } from './shared.ts';

/**
 * Opens the bus connection over a WebSocket.
 *
 * This is the transport every runtime has: browsers, Deno, Bun, Cloudflare Workers, and Node 22+
 * (which has a global `WebSocket` of its own). The server must have a `websocket` listener
 * configured; Jiku's deployment does, with TLS on the same certificate as the TCP port.
 *
 * # WHAT A BROWSER HAS TO ACCEPT
 *
 * The sentinel creds must be shipped to the browser, because the handshake needs them and there
 * is no filesystem to read them from. That is safe BY CONSTRUCTION and not by convention: the
 * creds file's own JWT carries `pub.deny: [">"]` and `sub.deny: [">"]`, so it authorises
 * literally nothing on its own. Every permission this connection ends up with is minted by the
 * auth-callout from the Zitadel token, which is the credential that actually matters and which
 * the browser should obtain through its own login.
 *
 * A service-account key is the opposite and must NEVER reach a browser. `ServiceUser` lives in
 * `@gravadigital/jiku/node` for that reason.
 */
export async function connect(options: ConnectOptions): Promise<Client> {
  if (options.credsFile) {
    throw new JikuInvalidRequest(
      'jiku: `credsFile` reads from the filesystem, which this entry point cannot do. Pass the ' +
        'file CONTENTS as `creds` instead — bundle it, fetch it, or read it in your build. It ' +
        'grants no permissions on its own, so shipping it is safe.',
    );
  }

  const servers = parseServers(options.servers);
  if (servers.length > 0 && transportOf(servers) !== 'ws') {
    throw new JikuInvalidRequest(
      `jiku: this entry point can only open WebSocket connections, and ${servers.join(', ')} ` +
        "is not one. A browser cannot open a raw TCP socket; use the server's websocket " +
        'listener (wss://host:port). In Node, importing "@gravadigital/jiku" gives you a ' +
        'connect() that speaks both.',
    );
  }

  return connectWith(
    (connectionOptions: ConnectionOptions) => wsconnect(connectionOptions),
    toBytes(options.creds),
    options,
  );
}

function toBytes(creds: string | Uint8Array | null | undefined): Uint8Array | undefined {
  if (creds === undefined || creds === null || creds === '') {
    return undefined;
  }
  return typeof creds === 'string' ? new TextEncoder().encode(creds) : creds;
}
