# Contract sync state

This file records **which commit of [jiku-go](https://github.com/gravadigital/jiku-go) this client
was last verified against**. It is the starting point for the next sync: diff that commit against
jiku-go's current `dev` and you have the exact set of changes this client has not seen yet.

It is maintained by hand as part of a sync, not generated. This file is only its bookmark.

## Why the pin is jiku-go and not Jiku

Jiku's contract is the ultimate authority, but this client does not read it. jiku-go does — it
pins a commit of Jiku, verifies against it, and records in
[`docs/reference.md`](https://github.com/gravadigital/jiku-go/blob/dev/docs/reference.md) which of
its behaviours the contract **forces** and which are Go's own idiom. That distinction is the
expensive part of a port and it has already been made there, so this client inherits it rather
than re-deriving it from the YAML.

So there are two pins and the second is transitive: **jiku-ts → jiku-go → Jiku.** A sync here
only ever diffs jiku-go.

**jiku-go is authority over the contract, not over the surface.** See
[Deliberate differences](#deliberate-differences): this client runs in browsers, which forbids
things a Go backend takes for granted and requires things it has no use for.

## Pinned state

|                        |                                                |
| ---------------------- | ---------------------------------------------- |
| **Repository**         | `gravadigital/jiku-go`                         |
| **Commit**             | `5f1bf26c9e0652b66fa3ba9d3b47ea85f800dcde`     |
| **Short**              | `5f1bf26`                                      |
| **Branch**             | `dev`                                          |
| **Subject**            | `docs(changelog): release 1.3.0`               |
| **Authored**           | 2026-09-25                                     |
| **Verified**           | 2026-09-25                                     |
| **Jiku, transitively** | `db0232c` — recorded by jiku-go at this commit |

### 1.3.0: the Refresh Token grant

Two commits since `a22eeb3`. `5f1bf26` only edits jiku-go's changelog. `74d0ac6` adds one
`[contract]` rule to `docs/reference.md`: **a refresh token exists only if the Native app has the
Refresh Token grant**, and `offline_access` is necessary but not sufficient. It is applied here.
`token()` names the grant when an unrenewable session expires, and the prose that said otherwise
was fixed. Its CLI half (`jiku login`, `jiku doctor`) has no counterpart here. The one part not
reproduced, a warning straight after login, is recorded under _Deliberate differences_.

`envelope.go`, `subject.go`, `events/` and jiku-go's own `CONTRACT.md` are untouched since
`a22eeb3`: no error code, no forbidden key and no subject rule moved, and the transitive Jiku pin
is still `db0232c`.

### Earlier

**The transitive Jiku pin closed on the 2026-09-25 sync**, as the entry before it predicted it
would. The old pin `2c945c6` predated jiku-go's own `CONTRACT.md`, so there was no record of which
Jiku commit it had been verified against and none was invented. This pin carries one: `db0232c`.

### The pin caught up with what was read, once the branch merged

The sync of 2026-09-25 **read** `fix/iterator-and-reference-docs` but **pinned** `8ae80e8`, the
tip of `dev` at the time. Two things lived only on that branch — `docs/reference.md` (`ad73292`),
the primary input to a sync and the source of every `[contract]` marking used here, and the
iterator fix (`52c09db`), whose test was ported. Reading `dev` would have missed both, and pinning
the branch would have risked a commit that a rebase or a squash-merge stops from existing.

**That branch merged into `dev` as `a22eeb3`** (PR #2), as an ordinary merge commit: `52c09db` and
`ad73292` kept their SHAs and are now reachable from `dev`. The reason for the gap is gone, so the
pin moves to the merge and the two commits are no longer "ahead" of it.

**Nothing was applied to close this gap, and nothing needed to be.** The merge introduced no
changes of its own over the branch tip, and `envelope.go` and `subject.go` are untouched between
`8ae80e8` and `a22eeb3` — no error code, no forbidden key, no subject rule moved. The work those
commits owed this client was already done on 2026-09-25: the iterator's end-of-collection rule is
pinned by `test/iterate.test.ts`, and `reference.md` is an **input** to a sync, never an output.

**This pin therefore records attention, not new work** — the case the procedure explicitly allows.

## What that commit contains

| Area                                                                    | State in this client                                |
| ----------------------------------------------------------------------- | --------------------------------------------------- |
| Request/reply over both planes, the envelope                            | **applied**                                         |
| Reads: `list`, `get`, `count`, `tags`, `iterate`, `iteratePages`, `all` | **applied**                                         |
| The contract: `describe`, `resource`, local validation, coercion        | **applied**                                         |
| Filters and the shape grammar                                           | **applied**                                         |
| Subjects, the inbox hash, both forbidden-key lists                      | **applied**                                         |
| Auth: device flow, service user, claims                                 | **applied**                                         |
| The error catalog — 35 codes, unchanged since `8ae80e8`                 | **applied**                                         |
| REQ-007, REQ-011, REQ-012 — the write rule and the codes they moved     | **applied**                                         |
| The iterator's end-of-collection rule (`52c09db`), as a test            | **applied**                                         |
| A refresh token needs the Refresh Token grant (`74d0ac6`)               | **applied**, bar the login-time warning — see below |

## Not yet applied

Everything still outstanding after the sync of 2026-09-25. Two entries, and both are deliberate
rather than pending transcription.

### The event plane — REQ-014 (`32176f1`, `13990f6`, `2a8125b`)

**Absent entirely, and it is a scope change rather than a sync.** There is no `events` module
here. jiku-go's is 16 event types, a JetStream consumer over `JIKU_EVENTS`, subject filters with a
load-bearing `v1` segment, start policies, and a permission error that names the six narrow
subjects to grant.

Building it means new exported API in a published package: a new entry point, a new dependency on
JetStream, and a permanent compatibility promise. **That is designed and agreed first, not folded
into a sync.** It is the largest item outstanding and the most self-contained — it adds a module
and changes nothing that exists.

Whoever builds it inherits these from jiku-go's porting checklist, all `[contract]`:

- the `v1` segment is always in the subject — `events.>` alone also catches `events.auth`
- no deduplication in the client; `eventId` is exposed for the consumer to do it
- ephemeral by default; a durable name is shared state and must be opt-in
- a durable acks explicitly, **after** the handler returns
- the raw payload is preserved alongside the decoded event
- permissions are the narrow six subjects, never `$JS.API.>`, which would let any holder delete
  the stream, purge it or lower its retention
- "stream not found" names **both** its causes — an absent stream, or a missing `STREAM.INFO`
  permission whose refusal is asynchronous and arrives as a timeout

One deployment fact rides along: `person-internal.yaml` grants no event permissions at all, so
`admin` and `user` cannot consume. That is a product decision recorded in jiku-go's `CONTRACT.md`,
not an omission for this client to work around.

### Tracing and timing (`573113e`)

**Not implemented here, by decision on the 2026-09-25 sync.** jiku-go's `RequestTrace`,
`Config.Logger` and the `auth` tracing types are instrumentation — `docs/reference.md` marks
nearly all of 1.2.0 as explicitly _not_ contract, and says a port should use whatever its
ecosystem already has.

The contract part is **conditional**, and binds only if this client ever grows tracing:

- the five `Jiku-*` header names must be reproduced verbatim, or core's breakdown never arrives
- instrumentation that is off must send **exactly** what an uninstrumented client sends

Recorded here so that a future implementation inherits the rule instead of rediscovering it. Until
then there is nothing to be wrong.

## Deliberate differences

Recorded so an absence is never mistaken for an oversight. These will not be ported, and a future
sync must not "fix" them.

**This client runs in browsers; jiku-go runs in backends.** The divergence is the runtime, and it
is not negotiable in either direction.

| Not here                                         | Why it cannot be                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServiceUser` in the browser build               | It signs an assertion with a private key. In a browser that key is in the bundle. It is exported from `/node` only, and that is the boundary                                                                                                                                                                                                                                          |
| `FileStore` in the browser build                 | No filesystem. And a refresh token in `localStorage` is readable by every script on the origin — jiku-go's reference says a browser port should ship no token store at all                                                                                                                                                                                                            |
| A mutex on `MemoryStore`                         | One event loop. There are no two goroutines to race                                                                                                                                                                                                                                                                                                                                   |
| `ListInto`                                       | `JSON.parse` already decodes in one pass. It removes two decoding passes Go has and JS does not                                                                                                                                                                                                                                                                                       |
| Output buffering, `json.Indent`                  | CLI-only, and there is no CLI here                                                                                                                                                                                                                                                                                                                                                    |
| A disk cache for discovery or a minted token     | No filesystem in a browser. Node could, but `ServiceUser` is Node-only here and a long-lived process holds its token in memory anyway — the CLI is the case that paid, and there is no CLI                                                                                                                                                                                            |
| A CLI                                            | jiku-go's `cmd/jiku` has no counterpart here and is not planned                                                                                                                                                                                                                                                                                                                       |
| A warning when `login()` yields no refresh token | jiku-go's reference says a port should say so right after login. jiku-go itself does it from its CLI, not its library, and this client has no CLI. A library that writes to the console surprises a GUI caller, so `login()` returns the tokens and its TSDoc tells the caller to check `refresh_token`. The `LoginRequired` at expiry does name the grant. Decided on the 1.3.0 sync |

| Only here                                                    | Why jiku-go has no need                                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket transport, dual `node`/`default` export conditions | No browser to reach                                                                                                                                       |
| `tokenGetter` / `staticToken`                                | Go callers implement the two-method `TokenSource` directly; these are a convenience for the bring-your-own-token case, which is the browser's normal case |
| `docs/browser.md`                                            | —                                                                                                                                                         |
| `test/iterate.test.ts`                                       | jiku-go has its own; this one exists because the behaviour ported even though the code did not — `iterate()` was already correct, and pinned by nothing   |

## Updating this file

Only as the last step of a sync, once `npm run check` is green and the changes are committed. A
pin that moves ahead of the work it describes is worse than a stale one: the next sync would diff
from a commit whose changes were never applied, and skip them silently.
