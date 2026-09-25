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

|                        |                                            |
| ---------------------- | ------------------------------------------ |
| **Repository**         | `gravadigital/jiku-go`                     |
| **Commit**             | `2c945c65e87249e76d09136998ac9182fb7eb001` |
| **Short**              | `2c945c6`                                  |
| **Branch**             | `dev`                                      |
| **Subject**            | `fix: softprops/action-gh-release version` |
| **Authored**           | 2026-08-25                                 |
| **Verified**           | 2026-09-25                                 |
| **Jiku, transitively** | **unrecorded** — see below                 |

**How this pin was established**, since it was set long after the fact: jiku-go's error catalog at
`2c945c6` is exactly the 28 codes this client carries, and grew to 33 at the very next content
commit. Both forbidden-key lists match byte for byte. The catalog is the sharpest dateable
signal jiku-go has, so the correspondence is not a guess from the release dates.

**The transitive Jiku pin is unknown, and that is not an oversight to fix.** jiku-go had no
`CONTRACT.md` at `2c945c6` — it introduced one on 2026-09-13. There is no record of which Jiku
commit that state was verified against, and inventing one would be worse than leaving it blank.
The next sync moves this pin forward to a jiku-go commit that _does_ carry one, and the gap
closes by itself.

## What that commit contains

| Area                                                                    | State in this client |
| ----------------------------------------------------------------------- | -------------------- |
| Request/reply over both planes, the envelope                            | **applied**          |
| Reads: `list`, `get`, `count`, `tags`, `iterate`, `iteratePages`, `all` | **applied**          |
| The contract: `describe`, `resource`, local validation, coercion        | **applied**          |
| Filters and the shape grammar                                           | **applied**          |
| Subjects, the inbox hash, both forbidden-key lists                      | **applied**          |
| Auth: device flow, service user, claims                                 | **applied**          |
| The error catalog — 28 codes at that commit                             | **applied**          |

## Not yet applied

Everything jiku-go has done since `2c945c6`, in order. This is the work a sync closes.

### `ab9e47c` — REQ-007, people writing commands directly (2026-08-27)

**Five error codes**, absent here: `file_not_available`, `invalid_attachment_id`,
`invalid_date_range`, `invalid_state_transition`, `stage_not_found`.

**And the prose, which is the urgent half.** REQ-007 retired the claim that product roles cannot
write; `admin` and `user` now publish most commands straight to the bus, with a three-tier split
that differs _within_ a role. This client still states the old rule in five places, two of them
read by users:

```
src/core.ts        "The product roles ... authorise every query and NO command"
src/client.ts      "A person's token cannot write here"
src/client.ts      the permission-denied message
docs/auth.md       "authorise every query and no command"
docs/browser.md    "You cannot, and that is policy"
```

This is not a missing feature. It is the client telling people something that stopped being true
a year ago, in the register of a rule.

### `de3e2d1` — REQ-011 and REQ-012 (2026-09-13)

**Two error codes**: `comment_not_owned`, `activity_not_editable`. REQ-011's two new commands
need no code here — `command()` is generic and this client enumerates no command list.

REQ-012 made requirement state transitions free, which left `invalid_state_transition` with no
emitter. **It is still added**, above: a code that loses its emitter keeps its constant, because
core keeps it too.

With these seven, the catalog reaches **35**, which is where jiku-go is today.

### `32176f1`, `13990f6`, `2a8125b` — the event plane, REQ-014 (2026-09-14)

**Absent entirely.** There is no `events` module here. jiku-go's is 16 event types, a JetStream
consumer over `JIKU_EVENTS`, subject filters with a load-bearing `v1` segment, start policies,
and a permission error that names the six narrow subjects to grant.

The largest single item on this list, and the most self-contained: it adds a module and changes
nothing that exists.

### `52c09db` — the iterator and `MemoryStore` (2026-09-18)

**No code to port, but a test to.** Both defects are absent here for reasons that are not
design:

- The iterator: `iterate()` already ends only on a missing cursor and is a generator, not a
  recursion. **Correct, and pinned by nothing.** It is covered only by integration tests, and a
  live server cannot produce an empty-page-with-a-cursor on demand — that shape depends on where
  the byte budget falls. jiku-go grew a seam to drive the page sequence without a bus precisely
  for this. That test belongs here.
- `MemoryStore`: the race cannot occur on one event loop. Nothing to port.

### `573113e`, `8ae80e8` — 1.2.0, performance and observability (2026-09-25)

Partly applicable, and it needs judgement rather than transcription:

|                                                                                             |                                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Discovery cached on disk, with `forgetDiscovery` and the retry rule                         | applicable to Node; **not** to the browser                                |
| A service user's minted token cached, off by default, key bound to issuer + key id + scopes | applicable to Node only — `ServiceUser` is Node-only here                 |
| `ListInto`                                                                                  | **not applicable.** It removes two decoding passes Go has and JS does not |
| Output buffering, `json.Indent`                                                             | **not applicable.** CLI-only, and there is no CLI here                    |
| Tracing and timing (`RequestTrace`, the `Jiku-*` headers)                                   | optional. If implemented, the five header names are contract              |

### Not portable at all

`18de1de` (jiku-go's sync procedure) and `ad73292` (its `reference.md`) are jiku-go's own
documents. `reference.md` is an **input** to a sync here, never an output.

## Deliberate differences

Recorded so an absence is never mistaken for an oversight. These will not be ported, and a future
sync must not "fix" them.

**This client runs in browsers; jiku-go runs in backends.** The divergence is the runtime, and it
is not negotiable in either direction.

| Not here                           | Why it cannot be                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServiceUser` in the browser build | It signs an assertion with a private key. In a browser that key is in the bundle. It is exported from `/node` only, and that is the boundary                               |
| `FileStore` in the browser build   | No filesystem. And a refresh token in `localStorage` is readable by every script on the origin — jiku-go's reference says a browser port should ship no token store at all |
| A mutex on `MemoryStore`           | One event loop. There are no two goroutines to race                                                                                                                        |
| `ListInto`                         | `JSON.parse` already decodes in one pass                                                                                                                                   |
| A CLI                              | jiku-go's `cmd/jiku` has no counterpart here and is not planned                                                                                                            |

| Only here                                                    | Why jiku-go has no need                                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket transport, dual `node`/`default` export conditions | No browser to reach                                                                                                                                       |
| `tokenGetter` / `staticToken`                                | Go callers implement the two-method `TokenSource` directly; these are a convenience for the bring-your-own-token case, which is the browser's normal case |
| `docs/browser.md`                                            | —                                                                                                                                                         |

## Updating this file

Only as the last step of a sync, once `npm run check` is green and the changes are committed. A
pin that moves ahead of the work it describes is worse than a stale one: the next sync would diff
from a commit whose changes were never applied, and skip them silently.
