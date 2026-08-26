import { connect as rawConnect, type NatsConnection } from '@nats-io/transport-node';

/**
 * A stand-in for core: it subscribes to the query and command planes and answers jiku
 * envelopes.
 *
 * It exists so the protocol layer can be exercised end to end — real subjects, a real inbox
 * prefix, real request/reply, real cursors — against any NATS, with no Zitadel and no
 * auth-callout. What it does NOT test is authentication, which is the one thing that needs the
 * real deployment; `live.test.ts` covers that when credentials are present.
 */
export interface FakeCore {
  connection: NatsConnection;
  /** Every subject the stand-in core was asked for, in order. */
  seen: string[];
  /** Every payload it was sent, decoded. */
  payloads: Record<string, unknown>[];
  stop(): Promise<void>;
}

/** How many items the stand-in `projects` collection holds. */
export const PROJECT_COUNT = 7;

export async function startFakeCore(servers: string): Promise<FakeCore> {
  const connection = await rawConnect({ servers, name: 'jiku-ts-fake-core' });
  const seen: string[] = [];
  const payloads: Record<string, unknown>[] = [];

  // `*` in a NATS subject matches ONE WHOLE TOKEN — it is not a prefix wildcard, so
  // `jiku-*` matches the literal token "jiku-*" and never "jiku-queries". This covers both
  // planes by matching the whole service token instead.
  const subscription = connection.subscribe('*.*.*.v1.>');
  void (async () => {
    for await (const message of subscription) {
      seen.push(message.subject);
      const method = message.subject.split('.v1.')[1] as string;
      const payload = JSON.parse(new TextDecoder().decode(message.data)) as Record<string, unknown>;
      payloads.push(payload);
      if (method === 'garbage.list') {
        // Not an envelope and not even JSON: what a misconfigured proxy in front of the bus
        // would produce.
        message.respond(new TextEncoder().encode('<html>502 Bad Gateway</html>'));
        continue;
      }
      const reply = answer(method, payload);
      if (reply !== undefined) {
        message.respond(new TextEncoder().encode(JSON.stringify(reply)));
      }
    }
  })();

  // subscribe() only queues the SUB on the wire. Without this flush the first request can
  // reach the server before the subscription does, and the bus answers "no responders" — which
  // would look like a bug in the client rather than a race in the harness.
  await connection.flush();

  return {
    connection,
    seen,
    payloads,
    async stop() {
      await connection.close();
    },
  };
}

function answer(method: string, payload: Record<string, unknown>): unknown {
  const page = (payload['page'] ?? {}) as { limit?: number; cursor?: string };

  switch (method) {
    case 'projects.list': {
      // A keyset cursor, in miniature: the cursor is the index of the next item. The page can
      // come back SHORTER than the limit and still carry a cursor, which is exactly the case a
      // hand-rolled `items.length < limit` loop gets wrong.
      const limit = Math.min(page.limit ?? 50, 200);
      const start = page.cursor ? Number(page.cursor) : 0;
      if (payload['count'] === 'only') {
        return {
          status: 'success',
          data: { items: [], page: { limit, returned: 0, total: PROJECT_COUNT } },
        };
      }
      // Deliberately hands back one FEWER item than asked for on the first page.
      const size = start === 0 ? Math.max(1, limit - 1) : limit;
      const items = [];
      for (let i = start; i < Math.min(start + size, PROJECT_COUNT); i++) {
        items.push({ id: 100 + i, name: `project ${i}` });
      }
      const next = start + items.length;
      return {
        status: 'success',
        data: {
          items,
          page: {
            limit,
            returned: items.length,
            ...(next < PROJECT_COUNT ? { cursor: String(next) } : {}),
            ...(payload['count'] === true ? { total: PROJECT_COUNT } : {}),
          },
        },
      };
    }

    case 'projects.get':
      return payload['id'] === 100
        ? { status: 'success', data: { id: 100, name: 'project 0' } }
        : {
            status: 'failure',
            errorCode: 'project_not_found',
            errorMessage: 'no existe',
            errorDetails: { field: 'id', value: payload['id'] },
          };

    case 'requirements.tags':
      return {
        status: 'success',
        data: { items: [{ key: 'modulo', values: ['facturacion', 'reportes'] }] },
      };

    case 'meta.describe':
      return {
        status: 'success',
        data: {
          resources: {
            projects: {
              base: { id: { kind: 'integer' }, name: { kind: 'string' } },
              includable: { client: { kind: 'relation', cardinality: 'one' } },
              filterable: { id: { kind: 'integer' }, status: { kind: 'enum', enum: 'status' } },
              sortable: ['id', 'createdAt'],
              defaults: { sort: ['-createdAt'], limit: 50, maxLimit: 200 },
              enums: { status: [{ value: 'activo' }, { value: 'cerrado' }] },
            },
          },
        },
      };

    case 'slow.list':
      // Never answers. The caller's timeout or AbortSignal is the only way out.
      return undefined;

    case 'clients.new':
      return { status: 'success', data: { id: 1 } };

    default:
      return {
        status: 'failure',
        errorCode: 'unknown_command',
        errorMessage: `no endpoint for ${method}`,
      };
  }
}
