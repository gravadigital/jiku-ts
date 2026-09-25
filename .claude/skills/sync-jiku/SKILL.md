---
name: sync-jiku
description: Sync this client with Jiku's contract, which it follows through jiku-go. Diffs jiku-go's dev branch against the commit pinned in CONTRACT.md, classifies each change as contract, runtime capability or Go idiom, applies what belongs here, and moves the pin. Use when jiku-go has been updated, when asked to check for contract drift, or when a command, error code or rule may have changed upstream.
---

# Sync with Jiku's contract, through jiku-go

This client follows Jiku's contract but does not read it. jiku-go does, and marks which of its
behaviours the contract forces. The full procedure and the reasoning behind each step is in
`docs/sync-jiku.md` — **read it before starting**. This file is the operational checklist.

## 0. Get the path to jiku-go

**Never guess it, never hardcode it, never reuse one from an earlier session.** It differs per
machine and the repo is not vendored here.

If the user did not give it, ask — one question, then stop until answered:

> Where is the jiku-go repository on this machine? (the repo root, e.g. `../jiku-go`)

Ask which ref too, unless it is obvious. **The default is `dev`**, but work that has not landed
there yet lives on a topic branch, and reading `dev` would then miss it entirely — see the rule
below.

Verify before anything else:

```bash
cd <GO> && git rev-parse --abbrev-ref HEAD    # note it; default is dev
test -f CONTRACT.md && test -f docs/reference.md && echo ok
```

**If `docs/reference.md` is missing, you are on a ref that predates it. Stop and ask** — it is the
primary input to step 2 and a sync without it is guesswork.

If the working tree is dirty, say so: the SHA will not describe what you actually read.

### The ref you READ and the commit you PIN are not the same question

Read from whatever ref the user names — a topic branch is legitimate when the work is in flight.

**But the pin may only ever be a commit reachable from `dev`.** A topic branch gets rebased,
squashed on merge, or deleted, and a pin into one points at a commit that no longer exists; the
next sync then has nothing to diff from. If the work you synced is not on `dev` yet, do everything
else, leave the pin where it is, and say so in the report.

## 1. Diff from the pin

```bash
git log --oneline <pinned>..<ref>        # in jiku-go; <ref> is dev unless told otherwise
git diff --stat <pinned>..<ref>
```

**Empty means done.** Report that and stop. Do not go looking for work that isn't there.

**Read the commit messages in full.** jiku-go's carry the reasoning, what was measured and what
was deliberately left out. They are often the only place that says whether a change is contract or
idiom.

Then read `<GO>/docs/reference.md` — every exported identifier of the three packages, each marked
**[contract]** or left unmarked as idiom. Read it live; never copy it into this repository.

**Its closing _Porting checklist_ is the acceptance criteria for this client.** It is the same
`[contract]` rules condensed into the order a port hits them, so walk it: anything unticked is
either work this sync owes, or a deliberate difference that belongs in `CONTRACT.md` with its
reason. Nothing there is optional for correctness.

## 2. Classify into three layers

Sort every change before touching code. **The skill proposes; the user confirms.**

| Layer                  | Signal                                                                                  | Action                                    |
| ---------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Contract**           | marked `[contract]` in reference.md; an error code, a rule, a subject shape, a wire key | **reproduce**                             |
| **Runtime capability** | needs a filesystem, a private key, threads, a process that outlives a request           | **declare** in `CONTRACT.md`, do not port |
| **Go idiom**           | a Go type shape, a decoding pass, a concurrency primitive                               | **translate or drop**                     |

For anything newer than reference.md, or any fix whose nature is not obvious, **state the proposed
classification and its reason and wait.** A `MemoryStore` mutex reads as a legitimate fix and ports
to nothing — one event loop.

**A whole new capability is not a sync.** See step 7.

## 3. Apply

**Extract lists with a script — never transcribe.** A hand-written snapshot is what put a phantom
duplicate into jiku-go's own catalog.

```bash
# error codes
grep -oE 'Code[A-Za-z]+ *= *"[a-z_]+"' <GO>/envelope.go | sed -E 's/.*"(.*)"/\1/' | sort -u
# event types
grep -oE '"[a-z]+\.[a-z.]+"' <GO>/events/event.go | tr -d '"' | sort -u
# the two forbidden-key lists (note the _ in the class: user_id, caller_id)
sed -n '/forbiddenQueryIdentityFields = /,/^}/p' <GO>/subject.go \
  | grep -oE '"[a-zA-Z_]+"' | tr -d '"'
sed -n '/forbiddenCommandFields = /p' <GO>/subject.go
```

Diff each against this client's own list **in both directions** before editing anything.

## 4. Hunt the prose

The step that finds real bugs. TypeScript checks types; nothing checks English, and this package
is published.

The live example: REQ-007 retired "product roles cannot write" and this client went on asserting
it in `src/core.ts`, `src/client.ts` (twice), `docs/auth.md` and `docs/browser.md` — none near any
code that changed, two read by users.

```bash
grep -rn "REQ-0" src test docs README.md
grep -rni "cannot write\|no command\|authorise every" src docs README.md
grep -rn "23 read\|20 write\|21 write" src docs README.md package.json
```

A sentence that is merely stale matters as much as one that is wrong.

## 5. Make the drift fail loudly

Every closed list taken from jiku-go gets a test checking **both directions** — what jiku-go has
and this lacks, _and_ what this has and jiku-go does not. One direction only lets a list grow
forever and never shrink, which is how a retired code goes unnoticed.

CI here has no access to jiku-go, deliberately. Commit what you extracted as a fixture under
`test/fixtures/` and refresh it during the sync; never read jiku-go at test time.

**Prove the test can fail.** Inject the drift, watch it fail, revert.

## 6. Verify

```bash
npm run check
```

All of it — format, lint, typecheck, tests, build, dist tests, package checks. Not a subset.

## 7. Record — in this order

1. `CHANGELOG.md` under `## [Unreleased]` — what changed in the contract, what it meant here
2. `CONTRACT.md` — move the pin and the date; update **Not yet applied** and **Deliberate
   differences**
3. Commit

**Move the pin last, only when green and committed**, and only to a commit **on `dev`** (step 0).
A pin ahead of the work makes the next sync diff from a commit whose changes were never applied
and skip them silently; a pin into a topic branch makes it diff from a commit that may not survive
the merge.

The pin records **attention, not equality** — it may move on a sync that ported nothing, if what
jiku-go did was all idiom.

## 8. Scope changes are not syncs

When jiku-go gains a whole capability — **the event plane is the standing example and is currently
outstanding** — that is new exported API in a published package: new entry points, new
dependencies, a permanent compatibility promise.

**Do not build it as part of a sync.** Record it in `CONTRACT.md` as a known gap, tell the user,
and let them decide. Design first, agree, then build.

## Reporting back

Say what changed **in the contract** and what it meant here, not which files you edited. Call out
explicitly:

- anything classified as capability or idiom and therefore deliberately not ported, with the reason
- prose that was wrong rather than merely stale — those are bugs users could have hit
- any new known gap recorded in `CONTRACT.md`
- whether the pin moved, and if not, why
