import { readFile } from 'node:fs/promises';

import { wsconnect, type ConnectionOptions } from '@nats-io/nats-core';
import { connect as tcpConnect } from '@nats-io/transport-node';

import type { Client } from '../client.ts';
import { parseServers, transportOf, type ConnectOptions } from '../config.ts';
import { JikuError } from '../errors.ts';
import { connectWith } from './shared.ts';

/**
 * Opens the bus connection, choosing the transport from the server URL.
 *
 * `nats://` and `tls://` open a TCP socket, which is what a Node service normally wants.
 * `ws://` and `wss://` open a WebSocket against the server's websocket listener — the same
 * transport a browser uses, available here so one piece of code can run in both.
 *
 * See `connectWith` for the four things this does that a hand-rolled NATS connect does not.
 */
export async function connect(options: ConnectOptions): Promise<Client> {
  const servers = parseServers(options.servers);
  const transport = servers.length > 0 ? transportOf(servers) : 'tcp';

  const open =
    transport === 'ws'
      ? (connectionOptions: ConnectionOptions) => wsconnect(connectionOptions)
      : (connectionOptions: ConnectionOptions) => tcpConnect(connectionOptions);

  return connectWith(open, await readCredsBytes(options), options);
}

async function readCredsBytes(options: ConnectOptions): Promise<Uint8Array | undefined> {
  if (options.creds !== undefined) {
    if (options.creds === null || options.creds === '') {
      return undefined;
    }
    return typeof options.creds === 'string'
      ? new TextEncoder().encode(options.creds)
      : options.creds;
  }
  if (options.credsFile === undefined) {
    return undefined;
  }
  try {
    return new Uint8Array(await readFile(options.credsFile));
  } catch (cause) {
    throw new JikuError(
      `jiku: the sentinel creds file ${JSON.stringify(options.credsFile)} is unreadable\n` +
        '  It grants no permissions on its own, but the connection cannot reach the ' +
        'auth-callout without it.',
      { cause },
    );
  }
}
