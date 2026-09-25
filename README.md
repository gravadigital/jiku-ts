# jiku-ts

A TypeScript client for **Jiku's API, which is served over NATS rather than HTTP**: 23 read
endpoints (queries) and 23 write endpoints (commands), request/reply, no REST anywhere.

It runs in **Node and in the browser** from one codebase — TCP where there is a socket,
WebSocket where there is not.

```sh
npm install @gravadigital/jiku
```

```ts
import { connect, anyOf, gte } from '@gravadigital/jiku';
import { ServiceUser } from '@gravadigital/jiku/node';

const auth = await ServiceUser.fromKeyFile('/etc/jiku/service-account.json', {
  issuer: 'https://id.example.com',
  projectId: '987654321098765432',
});

const client = await connect({
  servers: 'nats://localhost:4222',
  instance: 'dev',
  credsFile: '/etc/jiku/sentinel-client.creds',
  auth,
});

const page = await client.list<Task>('tasks', {
  filter: { projectId: 15, state: anyOf('backlog', 'activo'), createdAt: gte('2026-01-01') },
  sort: ['-createdAt'],
  limit: 20,
});

await client.close();
```

---

## Contents

- [Why this package and not a bare NATS client](#why-this-package-and-not-a-bare-nats-client)
- [Installing and importing](#installing-and-importing)
- [Authenticating](#authenticating)
- [Reading](#reading)
  - [Filters](#filters-the-operator-is-the-shape-of-the-value)
  - [Pagination](#pagination)
  - [The contract](#the-contract)
- [Writing](#writing)
- [Errors](#errors)
- [In the browser](#in-the-browser)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Development](#development)

---

## Why this package and not a bare NATS client

The request itself is not complicated. Three things about this bus are, and **each fails in a way
that does not point at its cause.**

### The inbox prefix

A connection may subscribe to exactly one inbox, `_INBOX.<hash(sub)>`. Anything else — including
the random default every NATS client generates — means the reply is published where you are not
listening. The request then **times out with no error visible to the caller**: the permissions
violation is recorded in the NATS _server's_ log, where nobody thinks to look. The symptom points
at core being down or slow. It is neither.

`connect()` always sets it.

### Two credentials, one of which grants nothing

The sentinel creds file denies itself publish and subscribe on `>`. What mints permissions is a
**Zitadel access token**, and it must carry a roles claim — which it only does if the reserved
Zitadel scopes were requested. A token minted without them connects to nothing, and the error
says only `Authorization Violation`.

### Tokens and reconnects

The auth-callout evaluates the token **at connect time**, and NATS does not re-check afterwards.
A reconnect re-runs the callout, so a token that expired in the meantime means the reconnect is
refused. This client hands the bus a _function_, not a frozen string, and keeps the token behind
it fresh on a timer.

---

## Installing and importing

```sh
npm install @gravadigital/jiku
```

Requires **Node ≥ 22.12**, or any browser. The package is **ESM only**; Node 22.12+ can
`require()` it — with an experimental warning on 22, silently on 24 — so a CommonJS project on a
current Node is not shut out.

It has four entry points, and which one you reach for says what your code needs:

| Import                    | What is in it                                      | Where it runs |
| ------------------------- | -------------------------------------------------- | ------------- |
| `@gravadigital/jiku`      | `connect`, `Client`, filters, errors, the contract | everywhere    |
| `@gravadigital/jiku/auth` | `TokenSource`, `tokenGetter`, `DeviceFlow`, claims | everywhere    |
| `@gravadigital/jiku/node` | `ServiceUser`, `FileStore`, `loadConfig`           | Node only     |
| `@gravadigital/jiku/nats` | the NATS client library, re-exported               | everywhere    |

The root entry resolves differently by runtime, and that is the whole browser story: under Node
you get a `connect()` that speaks **both TCP and WebSocket**, chosen by the URL scheme; a browser
bundler matches the other condition and gets a **WebSocket-only** build that contains no `node:`
import at all. Importing `@gravadigital/jiku/node` from a browser bundle is a resolution error,
which is a much better failure than a mysterious `node:fs` at runtime.

`@gravadigital/jiku/nats` exists so that code which also talks to the bus directly uses **one
copy** of the NATS library. Two copies in one dependency tree mean two sets of error classes, and
`error instanceof PermissionViolationError` then fails against the copy that threw.

---

## Authenticating

Everything interesting about authenticating to Jiku is the work of getting a Zitadel token. There
are three ways, and which is right depends entirely on who is calling.

### A service — a key file

```ts
import { ServiceUser } from '@gravadigital/jiku/node';

const auth = await ServiceUser.fromKeyFile('/etc/jiku/service-account.json', {
  issuer: 'https://id.example.com',
  projectId: '987654321098765432',
});
```

RFC 7523 JWT profile: no browser, no refresh token, no stored state. The private key _is_ the
credential, and a fresh access token is minted whenever one is needed.

Two things about the Zitadel side are not optional:

- **Access Token Type must be JWT.** A machine user left on the default opaque `Bearer` gets a
  token the callout cannot read, and the connection is refused. This is the single most common
  misconfiguration of this flow.
- **`profile` must be in the scopes** (it is, by default). The callout publishes an authentication
  event that core turns into a row in `users`, and core requires a _name_ on that event. A machine
  user's name reaches the callout through the userinfo endpoint, which only returns it when
  `profile` was requested. Without it: no row, and every later request answers
  `caller_not_authorized` — three services away from the cause.

### A person at a terminal — the device flow

```ts
import { DeviceFlow } from '@gravadigital/jiku/auth';
import { FileStore, defaultStorePath } from '@gravadigital/jiku/node';

const auth = new DeviceFlow({
  issuer: 'https://id.example.com',
  clientId: '987654321098765432@your_project',
  projectId: '987654321098765432',
  store: new FileStore(defaultStorePath('dev')),
});

await auth.login(); // opens a code in the terminal, once
```

`auth.token()` **never** starts an interactive flow — it throws `LoginRequired` instead. A call
that silently blocks on a human is the kind of surprise that takes a service down at 3am;
`login()` is the one method that waits for a person, and it is separate for that reason.

The store is the conventional location for a jiku session on a machine, so anything else there
shares one login instead of each sending somebody to the browser.

### Anything with a session of its own — bring your own token

```ts
import { tokenGetter } from '@gravadigital/jiku/auth';

const auth = tokenGetter({ getToken: () => session.accessToken() });
```

This is what a browser uses. The application has already authenticated its user with Zitadel's own
web SDK; there is nothing left for this library to do but present the token. The callback's result
is cached until a minute before expiry, so a callback that does real work is not called on every
reconnect.

---

## Reading

```ts
const page = await client.list<Task>('tasks', { filter: { projectId: 15 }, limit: 20 });
const task = await client.get<Task>('tasks', { id: 7, include: ['project'] });
const total = await client.count('tasks', { filter: { projectId: 15 } });
```

`T` is yours to assert. The returned field set changes with `fields` and `include`, so no single
shape fits every call.

### Reads are deny-by-default

Every resource declares five closed lists — base, includable, filterable, sortable, and an
external scope. **A name that is not declared does not exist**: it comes back as `invalid_fields`,
never as a silently ignored lever. An ignored filter would return _more_ data than was asked for,
which is the worst failure mode a read contract has.

### Filters: the operator is the shape of the value

That shape grammar is the contract, not a convention:

| Value shape            | Operator    |
| ---------------------- | ----------- |
| scalar                 | equality    |
| array                  | IN          |
| `{ not: … }`           | negation    |
| `{ gte: x, lte: y }`   | range       |
| `{ key: k, value: v }` | containment |

Use the builders rather than writing the objects by hand:

```ts
import { anyOf, not, gte, lt, between, contains } from '@gravadigital/jiku';

await client.list('tasks', {
  filter: {
    projectId: 15, // equality
    state: anyOf('analisis', 'planificacion'), // IN
    createdAt: between('2026-01-01', '2026-06-30'),
    type: not('otro'),
  },
});

// containment, where the resource sheet declares it
await client.list('requirements', { filter: { tag: contains('modulo', 'facturacion') } });
```

`anyOf` rather than `in` because `in` is a reserved word and cannot be an import binding.

For input that arrives as text — a CLI flag, a query string, a form field — `parseFilter` turns
the same grammar into a filter, and types the values from the contract:

```ts
import { parseFilter } from '@gravadigital/jiku';

const tasks = await client.resource('tasks');
const filter = parseFilter(['projectId=15', 'createdAt>=2026-01-01'], tasks);
// -> { projectId: 15, createdAt: { gte: '2026-01-01' } }   note: 15, not "15"
```

That typing matters. `{"projectId": "15"}` is not the same request as `{"projectId": 15}`, and
guessing "looks like a number, send a number" breaks any string column whose values happen to be
digits — a project code, for instance.

### Pagination

**The absence of a cursor is the only end-of-collection signal.** There is no `hasMore` field, and
a page can come back _shorter than the limit_ because of a byte budget — so a short page does not
mean the end. A loop that checks `items.length < limit` silently truncates.

Use the iterator:

```ts
for await (const task of client.iterate<Task>('tasks', { filter: { projectId: 15 } })) {
  console.log(task.title);
}
```

`iteratePages` hands back each page whole when the metadata matters, and `all()` collects
everything — convenient and dangerous in the same way, so prefer `iterate` for anything large.

A limit above the resource's `maxLimit` is **clamped silently** — success, not failure. Read the
effective value back from `page.limit`.

### The contract

```ts
const contract = await client.contract(); // meta.describe, fetched once and cached
const tasks = await client.resource('tasks'); // one resource, variant resolved
```

`meta.describe` projects **the same structures the validator reads** to reject names. So every
name it declares works, and one it does not declare answers `invalid_fields` — there is no second
copy to drift. A table compiled into this library would be exactly that second copy.

Check a query before it costs a round trip:

```ts
import { validateQuery, assertValidQuery } from '@gravadigital/jiku';

const problems = validateQuery(tasks, { filter: { projectid: 1 } });
// [ 'unknown filter "projectid"; did you mean "projectId"?\n    allowed: area, createdAt, …' ]
```

It is deliberately conservative: it flags names that are certainly wrong and never invents a rule
of its own, so it cannot refuse a query the server would have accepted.

**Three resources keep their fields somewhere else.** `comments`, `activity` and `subscriptions`
are _discriminated_: their base, includable and filterable arrive empty, and the real whitelists
live per variant under `entityType`. Read them through `forVariant` — or `client.resource(name,
variant)` — or they will look like they have no fields at all. With no variant named you get the
**union** of every variant, which is deliberate: validation must never reject what the server
would accept.

---

## Writing

```ts
await client.command('clients.new', { name: 'Acme', creator: '123456789012345678' });
```

**A command is not the mirror image of a query.** Three asymmetries, all deliberate on core's
side:

- **Who may write is not one rule.** Every product role authorises every query, but writes split
  three ways per role in core's map. Since REQ-007 `admin` and `user` publish most commands
  straight to the bus; `external-user` publishes none and reaches its six only as a side effect of
  the api acting on its behalf, carrying the reserved `actor` envelope. Core is the **only**
  validation point — the business rules that used to live in the api moved there — so a refused
  write arrives as a `JikuFailure` with a code, not as a bus rejection. See
  [docs/auth.md](docs/auth.md).
- The acting person may travel in the **body** (`creator`, `author`, `editor`), because the subject
  identifies the _service_ that published, not the human behind it. Those fields are **optional**
  since REQ-007: core resolves the actor from the caller when they are absent.
- There is no JetStream and no retry. If core is down the request times out and the operation did
  not happen.

The two planes also reject different payload keys. On a **read**, the caller comes from the
subject and only from the subject, so eleven identity names are refused outright. On a **write**,
only `actor` is — several commands take a `userId` or a `personId` as _domain data_ (who is being
subscribed, whose hours these are), and rejecting those would refuse what the server accepts.

---

## Errors

Everything this package throws is a `JikuError`:

| Class                  | Means                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `JikuInvalidRequest`   | rejected **locally**, before publishing. Nothing reached the network. |
| `JikuFailure`          | core answered `status: failure`. Has `code`, `details`, `hint()`.     |
| `JikuTimeout`          | nothing replied.                                                      |
| `JikuNoEndpoint`       | the bus said _immediately_ that nothing is subscribed.                |
| `JikuPermissionDenied` | the **bus** refused to publish, by subject.                           |
| `JikuNotConnected`     | the client was closed.                                                |

```ts
import { isCode, ErrorCode, JikuFailure } from '@gravadigital/jiku';

try {
  await client.get('tasks', { id: 7 });
} catch (error) {
  if (isCode(error, ErrorCode.TaskNotFound)) return null;
  if (error instanceof JikuFailure) {
    console.error(error.code, error.details?.allowed, error.hint());
  }
  throw error;
}
```

`JikuNoEndpoint` is a **firmer signal than a timeout** and deserves its own branch: the bus
answered at once that no endpoint is registered, so it is neither a slow core nor an inbox
problem — the method almost certainly does not exist, or it was asked on the wrong plane or
instance.

`JikuPermissionDenied` is the **bus** refusing by subject, before core sees anything. Core refuses
by role and by its own `users` table, _after_. Confusing the two sends you looking in the wrong
service, which is why the message says so every time.

**The error catalog is core's, and it grows.** `ErrorCodeValue` is deliberately widened to
`string`: a code this library has never heard of still arrives as a `JikuFailure` with its
`details` intact. Use `isCode`, never a `switch` with a `default` that assumes it has seen
everything.

`isJikuError(e)` is a brand check that survives two copies of this package in one dependency tree,
where `instanceof` quietly stops working.

---

## In the browser

```ts
import { connect } from '@gravadigital/jiku';
import { tokenGetter } from '@gravadigital/jiku/auth';

const client = await connect({
  servers: 'wss://bus.example.com:8443',
  instance: 'prod',
  creds: SENTINEL_CREDS, // the file's contents, bundled
  auth: tokenGetter({ getToken: () => session.accessToken() }),
});
```

Three things to know, and none of them is a workaround:

**The sentinel creds must be shipped to the browser, and that is safe by construction.** The
handshake needs them and there is no filesystem to read them from. The file's own JWT carries
`pub.deny: [">"]` and `sub.deny: [">"]`, so it authorises literally nothing on its own — every
permission the connection ends up with is minted by the auth-callout from the Zitadel token. It is
the one credential in this system that can be published, and it is that way on purpose.

**A service-account key must never reach a browser.** `ServiceUser` lives in the Node-only entry
point for exactly that reason. A browser hands this library the access token it already holds.

**There is no token store in the browser, deliberately.** A refresh token in `localStorage` is
readable by every script on the origin. The application owns its session; this library just asks
for the current token.

The server needs a `websocket` listener — Jiku's deployment has one, with TLS on the same
certificate as the TCP port. Bundle cost, measured with esbuild: **164 KB minified, 49 KB gzipped**, almost all of it the NATS client itself.

---

## Configuration

Build the options in code, or read the shared config file and environment:

```ts
import { loadConfig } from '@gravadigital/jiku/node';

const config = await loadConfig(); // ~/.config/jiku/config.yaml + JIKU_* env
const client = await connect({ ...config, auth });
```

`loadConfig` deliberately does **not** return an `auth` — choosing an identity is your decision
and it will not guess.

| Option              | Environment       | Default                  |
| ------------------- | ----------------- | ------------------------ |
| `servers`           | `JIKU_SERVERS`    | `nats://localhost:4222`  |
| `instance`          | `JIKU_INSTANCE`   | `dev`                    |
| `credsFile`         | `JIKU_CREDS`      | — (required)             |
| `timeoutMs`         | `JIKU_TIMEOUT`    | `15000`                  |
| `zitadel.issuer`    | `JIKU_ISSUER`     | `https://id.example.com` |
| `zitadel.clientId`  | `JIKU_CLIENT_ID`  | —                        |
| `zitadel.projectId` | `JIKU_PROJECT_ID` | —                        |
| `zitadel.keyFile`   | `JIKU_KEY_FILE`   | —                        |

The timeout default is **above** the server's, not below: `NATS_QUERY_TIMEOUT_MS` is 10s and
PostgreSQL's `statement_timeout` is 8s, so the database cuts first and you get a `query_timeout`
reply that explains itself. A shorter client timeout turns that back into silence.

`creds: null` says "this bus needs no sentinel creds". That is not how you talk to Jiku, but it is
how you point this client at a plain NATS in a test. It is `null` rather than an empty string on
purpose: an unset environment variable produces `undefined`, so "no creds" can only ever be
something you wrote deliberately.

---

## API reference

Every export carries TSDoc that your editor will show on hover. The shape of it:

**Connecting** — `connect(options)`, `Client.fromConnection(nc, options)`

**Reading** — `client.list`, `.get`, `.iterate`, `.iteratePages`, `.all`, `.count`, `.tags`,
`.query`, `.request`

**Writing** — `client.command`

**Contract** — `client.contract`, `.describe`, `.resource`; `forVariant`, `validateQuery`,
`assertValidQuery`, `coerce`, `resourceOf`, `fieldNames`, `filterableNames`, `sortableNames`,
`includableNames`, `variantNames`

**Filters** — `anyOf`, `not`, `gt`, `gte`, `lt`, `lte`, `between`, `range`, `contains`,
`parseFilter`

**Errors** — `JikuError` and subclasses, `ErrorCode`, `isCode`, `isJikuError`

**Subjects** — `subject`, `inboxPrefix`, `hashUserId`, `splitMethod`, `SERVICE_QUERIES`,
`SERVICE_COMMANDS`

**Lifecycle** — `client.close()`, which drains rather than closing outright so a reply already in
flight is not lost.

`Client` also implements `Symbol.asyncDispose`, so `await using client = await connect(…)` works
where the syntax does — **Node 24+**, or any TypeScript build targeting something older, which
downlevels it. It is a _syntax error_ on Node 22 even though the package supports Node 22, so the
examples use `close()` in a `finally`.

Longer documents live in [`docs/`](docs/):

- [**The protocol**](docs/protocol.md) — subjects, the inbox, envelopes, filters, pagination,
  the error catalog
- [**Authenticating**](docs/auth.md) — the chain link by link, and what each link looks like
  when it breaks
- [**Running in a browser**](docs/browser.md) — how the entry point resolves, bundling, and why
  shipping the sentinel creds is safe
- [**Following the contract**](docs/sync-jiku.md) — how this client is kept in step with Jiku,
  through [jiku-go](https://github.com/gravadigital/jiku-go); [CONTRACT.md](CONTRACT.md) records
  which commit of it this was last verified against

Runnable programs live in [`examples/`](examples/).

---

## Development

```sh
npm install
npm run check          # format, lint, typecheck, test, build, package
```

| Script                     | What it does                                            |
| -------------------------- | ------------------------------------------------------- |
| `npm test`                 | unit tests; hermetic, no network                        |
| `npm run nats:up`          | a throwaway NATS with TCP on 4322 and WebSocket on 8322 |
| `npm run test:integration` | protocol tests against that NATS, over both transports  |
| `npm run check:package`    | `publint` and `attw` on the real tarball                |

The sources are run directly by `node --test` through type stripping and compiled by `tsc` for
publishing — one set of files, no build step in the test loop.

The integration suite runs a **stand-in core** against a plain NATS, so it needs no Zitadel and no
credentials. What it cannot fake is the authentication chain; `JIKU_TEST_LIVE=1` runs a separate
suite against a real deployment, using whatever identity the machine already has.

`test/fixtures/describe.json` is a **real** `meta.describe` reply captured from a running core,
and `test/fixtures/inbox-vectors.json` pins inbox hashes **observed from a running auth-callout**.
Both are captured rather than written: a hand-made fixture only ever tests the fixture. The inbox
hash in particular is computed independently by the callout and by this client, with no channel
between them, and when they disagree the symptom is a request that times out with no error
anywhere.

### Branches and releases

```text
   feature work ──▶ dev ──▶ main ──▶ tag vX.Y.Z
                    │        │         │
                    test     test      test, then publish to npm
```

Development lands on `dev`, by pull request or by local merge; both are tested. `main` only
receives merges from `dev` and is tested again on the merged tree.

**Publishing from CI is currently off** and releases are published by hand; the automated release
is preserved, commented, in `.github/workflows/release.yml`.

[CONTRIBUTING.md](CONTRIBUTING.md) has the release steps and what the release workflow refuses to
do.

---

## License

Apache-2.0. See [LICENSE](LICENSE).
