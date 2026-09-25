# Following Jiku's contract, through jiku-go

This client tracks Jiku's NATS contract, but it does not read it. [jiku-go][go] does — it pins a
commit of Jiku, verifies against it, and records in its `docs/reference.md` which of its
behaviours the contract **forces** and which are Go's own idiom. That marking is the expensive
part of a port, and it has already been done there.

So the chain is **jiku-ts → jiku-go → Jiku**, and a sync here only ever diffs jiku-go.
`CONTRACT.md` is the bookmark; this document is the procedure; `.claude/skills/sync-jiku/` is the
operational checklist.

[go]: https://github.com/gravadigital/jiku-go

---

## The one thing that makes this different from jiku-go's own sync

**jiku-go is not the contract. It is an implementation of it.**

When jiku-go syncs against Jiku, every change in the YAML is contract by definition — the only
question is how to apply it. Here that is not true. A commit in jiku-go can be any of three
things, and they call for opposite responses:

|                                  | Example                                           | What to do                 |
| -------------------------------- | ------------------------------------------------- | -------------------------- |
| **The contract showing through** | a new error code; a rule about who may write      | **reproduce it**           |
| **A runtime capability**         | an on-disk token cache; a mutex on a shared store | **declare it** — see below |
| **Go's own idiom**               | `ListInto`; the `Iterator` struct                 | **translate or drop it**   |

Getting this wrong is expensive in both directions. Reproducing an idiom adds complexity for a
problem this runtime does not have; skipping a contract rule fails silently against a real
deployment.

Two worked examples from jiku-go's own history, both of which look like ordinary fixes:

- **`MemoryStore` was not safe for concurrent use**, and jiku-go added a mutex. There is nothing
  to port: one event loop, no two goroutines to race. A faithful port would add a lock that can
  never be contended.
- **The iterator silently truncated a sweep** when a page came back empty but still carried a
  cursor. Also nothing to port — `iterate()` here already ends only on a missing cursor, and is a
  generator rather than a recursion. But it is correct **by idiom, not by design**, and until
  that fix it was pinned by nothing: the shape depends on where the byte budget falls, which a
  live server cannot be made to produce on demand. **The test ported even though the code did
  not.**

> **The unit that transfers reliably is the behaviour and its test, not the diff.** A commit that
> changes no line here can still owe this repository a test.

---

## Runtime capabilities are declared, never silently skipped

This client runs in browsers. jiku-go runs in backends. Some differences will never close, and
they are not debt:

- No `ServiceUser` in a browser build — it signs an assertion with a private key, which in a
  browser would be in the bundle.
- No `FileStore` in a browser build — no filesystem, and a refresh token in `localStorage` is
  readable by every script on the origin.
- No mutex on `MemoryStore` — one event loop.

And it runs in the other direction too. This client has a WebSocket transport, dual export
conditions, and `tokenGetter`/`staticToken` for the bring-your-own-token case that is a browser's
normal one. jiku-go needs none of them.

**Record every one of these in `CONTRACT.md` under "Deliberate differences", with its reason.** An
absence is indistinguishable from an oversight; a declaration is not. This is the whole reason
the section exists, and a future sync must not "fix" what it lists.

---

## Why a commit SHA and not a version

**jiku-go's tags lag its `dev`.** They are cut from `main`, exactly as Jiku's are. The event plane
and the REQ-011/012 catch-up were both on `dev` well before a tag covered them.

**Its version is not this client's version.** SemVer there is a promise about _Go_ identifiers;
here it is a promise about what the four entry points export. A Go-only refactor bumps jiku-go
and changes nothing here; a small contract change can force a major here.

So what gets pinned is a commit SHA. It is exact, it always exists, and it never arrives late.

---

## The procedure

### 1. Find what changed

Read the pinned commit from `CONTRACT.md`, then in the jiku-go repo on `dev`:

```bash
git log --oneline <pinned>..HEAD
git diff --stat <pinned>..HEAD
```

Empty means there is nothing to sync. Say so and stop.

**Read the commit messages, not only the diff.** jiku-go's are unusually long and carry the
reasoning — why a change was made, what was measured, what was deliberately left out. They are
the equivalent of Jiku's `REQ-*.md` documents for this direction, and they are frequently the
only place that says whether something is contract or idiom.

Then read jiku-go's `docs/reference.md`, which marks every behaviour **[contract]** or leaves it
unmarked as idiom. It is the primary input to step 2 and it is read live from jiku-go — a fact
about the counterpart, never copied into this repository as procedure.

### 2. Classify — and propose, do not decide

Sort every change into the three layers above **before touching code**.

For anything already marked **[contract]** in jiku-go's reference, the classification is settled.
For code newer than that document, or for a fix whose nature is not obvious, **state the proposed
classification and its reason, and let the user confirm it.** The `MemoryStore` mutex is the
standing example of a change that reads as a legitimate fix and ports to nothing.

A change that adds a whole capability is **not a sync** — see below.

### 3. Apply

**Extract lists with a script; never transcribe.** Error codes, event types, the forbidden-key
lists and the inbox hash parameters are all closed lists that can be pulled straight out of
jiku-go's source:

```bash
grep -oE 'Code[A-Za-z]+ *= *"[a-z_]+"' <jiku-go>/envelope.go | sed -E 's/.*"(.*)"/\1/' | sort -u
```

Hand-transcription is what put a phantom duplicate into jiku-go's own catalog snapshot. There is
no reason to repeat that here.

### 4. Hunt the prose

**The step that finds real bugs, and the one most likely to be skipped.** TypeScript checks types;
nothing checks English. This client is published to npm and its prose is what an integrator reads.

The live example: REQ-007 retired the rule that product roles cannot write, and this client went
on asserting the old rule in five places — `src/core.ts`, `src/client.ts` twice, `docs/auth.md`
and `docs/browser.md`. None is near any code that changed. Two are read by users.

Grep the whole repo — TSDoc comments, `docs/*.md`, `README.md`, error message strings — for:

- **Rules stated as fact.** "the product roles authorise no command", "a person's token cannot
  write here".
- **Counts.** `23 read endpoints`, `20 write` — they are in `package.json`'s description too.
- **Error codes explained in prose**, chiefly `docs/auth.md`.
- **Anything naming a request**: `grep -rn "REQ-0"`.

### 5. Make the drift fail loudly

A sync that only changes code is a sync that will be needed again for the same reason. Every
closed list that came from jiku-go gets a test that checks **both directions** — a value jiku-go
declares and this client lacks, _and_ a value this client has that jiku-go does not.

Checking only the first lets the list grow forever and never shrink, which is how a retired code
goes unnoticed. jiku-go's own catalog test had exactly that hole for a full release.

**A regression test must be shown to fail.** Inject the drift, watch it fail, revert. A test that
passes for the wrong reason is worse than no test.

Note that this repository's CI has no access to jiku-go, deliberately — the same rule jiku-go
applies to Jiku. Anything extracted from jiku-go is therefore committed here as a fixture and
refreshed during a sync, never read live at test time.

### 6. Verify

```bash
npm run check
```

That is format, lint, typecheck, unit tests, build, the built-output tests and the package checks.
All of it, not a subset.

### 7. Record — in this order

1. `CHANGELOG.md` under `## [Unreleased]` — what changed in the contract, and what it meant here.
2. `CONTRACT.md` — move the pin, update the date, update both the "Not yet applied" list and
   "Deliberate differences".
3. Commit.

**Move the pin last, only when green and committed.** A pin ahead of the work makes the next sync
diff from a commit whose changes were never applied, and skip them silently.

The pin records **attention, not equality**. It may move forward on a sync that ported nothing, if
what jiku-go did was all idiom. What it must never do is move past work that was not looked at.

---

## Scope changes are not syncs

A sync applies changes to surface this client **already covers**. When jiku-go gains a whole
capability, that is new exported API in a published package: new entry points, new dependencies, a
permanent compatibility promise.

**The event plane is the standing example**, and it is the largest thing currently outstanding —
a JetStream consumer, 16 event types, subject filters with a load-bearing version segment. Do not
fold it into a sync. Record it in `CONTRACT.md` as a known gap, say so, and let the user decide.
Design first, agree, then build.

---

## What this client does _not_ track

- **jiku-go's CLI.** `cmd/jiku` has no counterpart here and none is planned.
- **jiku-go's internal layout**, its build tooling, its `tools/`.
- **The read plane's field lists.** Discovered at runtime through `meta.describe` and deliberately
  never compiled in — on both sides. A new filterable field needs no change here. A change to the
  _shape_ of `describe`, or to the six query levers, does.
- **Go-shaped performance work.** `ListInto` exists because Go decoded a list reply three times;
  `JSON.parse` does not.
