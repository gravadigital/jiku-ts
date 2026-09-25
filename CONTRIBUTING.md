# Contributing

## Getting set up

```sh
npm install
npm run check
```

`check` is the whole gate: format, lint, typecheck, unit tests, build, the built-package tests, and
`publint` + `attw` on the real tarball. It is what CI runs, so a green local run means a green CI
run.

You need **Node ≥ 22.12**. Nothing else — no Docker, no NATS, no credentials — for the default
suite.

## How the sources are built and run

One set of `.ts` files, two consumers:

- `node --test` runs them **directly**, through Node's type stripping.
- `tsc` compiles them to `dist/` for publishing.

That is why imports name `./errors.ts` and not `./errors.js`: Node does not rewrite a `.js`
specifier to a `.ts` file, so the runtime needs the real name, and `rewriteRelativeImportExtensions`
turns it into `.js` on the way into `dist/`.

It is also why `isolatedModules` and `verbatimModuleSyntax` are on, and why there are **no `enum`s,
namespaces or decorators** anywhere. Type stripping is a per-file transform with no type
information; it cannot tell an imported type from an imported value and it refuses those three
constructs. Both flags make the compiler reject anything it could not handle.

## Testing

```sh
npm test                    # unit; hermetic, no network
npm run nats:up             # a throwaway NATS: TCP on 4322, WebSocket on 8322
npm run test:integration    # protocol tests over both transports
npm run nats:down
```

Three layers, and they answer different questions:

**Unit tests** cover the logic. `test/fixtures/describe.json` is a **real** `meta.describe` reply
captured from a running core — a hand-written fixture would only test the fixture.

**Integration tests** run a stand-in core against a plain NATS, over TCP _and_ over WebSocket. They
exercise real subjects, a real inbox prefix, real cursors and real error mapping, with no Zitadel
involved. They skip themselves when no NATS is reachable, so `npm test` stays hermetic.

**Live tests** are the only ones that can prove the authentication chain. They need a real
deployment and credentials, so they never run in CI:

```sh
JIKU_TEST_LIVE=1 npm run test:integration                   # a session already stored
JIKU_KEY_FILE=… JIKU_TEST_LIVE=1 npm run test:integration   # a machine user
```

With neither, they fail with `LoginRequired` rather than opening a browser. Run the quickstart
example once to get a session.

### `test/fixtures/inbox-vectors.json` is captured, not computed

The inbox hash is computed independently by the auth-callout (to mint the subscribe permission) and
by this client (to pick its inbox), **with no channel between them**. When they disagree, the
symptom is a request that times out with no error the caller can see, and the violation is logged
by the NATS server where nobody looks.

Those values were **observed from a running callout**. Generating them from this implementation
instead would make the test assert that the code agrees with itself, which is exactly the thing
that cannot go wrong. If the algorithm ever has to change, capture new values from a callout that
has the change — do not recompute them here.

## What this codebase is trying to be

The comments are a large part of the product. When a line exists because of a failure mode that
does not point at its own cause, say so — the reader who needs that comment is looking at a
timeout and about to blame the wrong service.

A few rules that follow from that:

- **Never refuse what the server accepts.** Local validation exists to save a round trip and to
  name the alternatives. It flags names that are certainly wrong and invents no rule of its own. A
  false rejection is worse than no validation at all.
- **The error catalog is core's, and it grows.** Nothing here switches exhaustively on a code.
- **Explain the asymmetries rather than smoothing them over.** Reads and writes reject different
  payload keys, the two planes are separate subject tokens, and the client timeout sits _above_ the
  server's. Each of those looks like an inconsistency until you know why.
- **Two implementations of one rule will drift.** If something has to agree with the callout or
  with core, pin it with a captured fixture rather than a comment.

That last rule is why this repository tracks another one. [jiku-go][go] is a third implementation
of the same contract, and the most complete — it reads Jiku's own schemas and marks which of its
behaviours the contract forces rather than Go. Most work here starts there:
[CONTRACT.md](CONTRACT.md) records which commit of it this client was last verified against, and
[docs/sync-jiku.md](docs/sync-jiku.md) is the procedure for closing the gap, run by the
`sync-jiku` skill.

Its surface is **not** this client's target. A browser cannot hold a service user's private key,
and jiku-go has no use for a WebSocket transport. Those differences are permanent and are listed
with their reasons under _Deliberate differences_ in `CONTRACT.md`, so that an absence is never
mistaken for an oversight.

[go]: https://github.com/gravadigital/jiku-go

## Style

Prettier and ESLint decide. Run `npm run format` before committing.

Where a lint rule is disabled, the line above says why. `||` on strings is deliberate throughout —
an empty `instance` or `servers` means _unset_, and `??` would keep the empty string and produce a
subject nobody is subscribed to.

## Public types accept `undefined` explicitly

`exactOptionalPropertyTypes` is on, which means `foo?: string` rejects `foo: undefined`. For an
**input** type that is hostile: `connect({ ...config, auth })` is the documented pattern, and
`config.servers` is `string | undefined`. So every optional property of an options interface is
written `foo?: T | undefined`.

**Output** types stay strict. Those are produced here, and a caller should be able to trust that an
absent key means an absent key.

## Branches

Two long-lived branches, and each one has exactly one job.

**`dev` is where development lands.** Push to it directly after a local merge, or open a pull
request into it — both are tested the same way. This is the branch that moves.

**`main` is what gets released.** It only ever receives merges from `dev`. Pushing to it runs the
same tests again, on the merged tree, which is not the tree either side had before the merge —
that is the whole reason to re-run them rather than trusting `dev`'s green tick.

**Tags publish.** Nothing else does. A push to a branch cannot reach npm: the CI workflow holds a
read-only token and no step in it touches a registry.

```text
   feature work ──▶ dev ──▶ main ──▶ tag vX.Y.Z
                    │        │         │
                    test     test      test, then publish to npm
```

## Commits and pull requests

Conventional-ish subjects (`fix:`, `feat:`, `docs:`, `test:`, `chore:`) in the imperative mood. Say
_why_ in the body; the diff already says what.

CI must pass, and **the changelog entry belongs in the same change as the code**. Writing it later
means writing it from a diff, which is how a changelog ends up describing what moved instead of
what it means.

## Versioning

Semver against the four entry points. A breaking change to anything exported from them moves the
**major**; a backwards-compatible addition moves the **minor**; a fix moves the **patch**.

Two things are public without being exports, and changing either is a **major**:

- **The shape of the `exports` map.** Which specifiers resolve, and to what. Removing a subpath,
  or making the root entry resolve somewhere else under a condition, breaks consumers exactly as
  hard as deleting a function.
- **The `engines` floor.** Raising it drops runtimes that were working.

Widening an input type or adding an optional option is a minor. Narrowing one is a major, even
when nothing in the runtime changed — it can fail somebody's build.

## Releasing

> **⛔ Publishing from CI is off right now.** The npm account has no working 2FA, and npm refuses
> a publish without either 2FA on the account or a granular token that bypasses it. Releases are
> published **by hand** until that is sorted. `.github/workflows/release.yml` still holds the
> whole automated release, commented, with three blocks marked `RE-ENABLE`; see
> [Turning CI publishing back on](#turning-ci-publishing-back-on).

### By hand, today

```sh
# 1. merge dev into main, and let CI pass
git checkout main && git pull && git merge --no-ff dev && git push

# 2. move the Unreleased section of CHANGELOG.md under the new version heading, commit, push

# 3. bump — npm version writes package.json, package-lock.json, commits and tags.
#    Skip this for 1.0.0: package.json is already at 1.0.0, so it is only a tag.
npm version minor                       # or patch, or major
git tag -a v1.0.0 -m "v1.0.0"           # 1.0.0 only, instead of the line above

# 4. run the gate yourself — nothing else will
npm run check
npm run nats:up && npm run test:integration && npm run nats:down

# 5. publish
npm publish --access public

# 6. push the tag, so git records what was released
git push origin main --follow-tags
```

Step 4 is not optional. It is the whole gate the release workflow used to run for you, and
publishing is the one action that cannot be undone: a version can be deprecated but never reused.

### Turning CI publishing back on

Two things have to be true first:

1. **2FA on the npm account.** `npm profile enable-2fa auth-and-writes`, or the same from the
   website. It is a hard requirement twice over: npm will not publish without it, and `npm trust`
   explicitly rejects tokens that bypass 2FA.
2. **A trusted publisher on the package**, which can only be configured once the package exists —
   which by then it will, from the manual releases above.

```sh
npm trust github @gravadigital/jiku \
  --repo gravadigital/jiku-ts \
  --file release.yml \
  --env npm \
  --allow-publish

npm trust list @gravadigital/jiku
```

Then uncomment the three `RE-ENABLE` blocks in `.github/workflows/release.yml`: the `push: tags`
trigger, the `npm publish` step, and the `github-release` job. From that point a tag is the only
thing that publishes, and **there is no npm token in this repository** — GitHub mints a
short-lived identity token for this exact workflow, repository and environment, npm checks it
against the trusted publisher, and provenance is attached automatically.

Once it is back on, the workflow refuses four things before publishing anything:

| Refusal                              | Why it exists                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| the tag is not reachable from `main` | releases are cut from `main`; this rules out a tag on a branch that never went through it |
| the tag and `package.json` disagree  | tagging by hand instead of with `npm version`                                             |
| the version is already on npm        | a published version can be deprecated but never reused                                    |
| `CHANGELOG.md` has no section for it | release notes are written before the release, not after                                   |

Then it runs the whole gate again, **plus the integration suite** that `npm run check` leaves out
because it needs a server.

#### Why the publish step runs on a different Node

Trusted publishing needs **npm ≥ 11.5.1 and Node ≥ 22.14**, and the entire Node 22 line ships npm
10.x — 22.23 still does. So the publish step sets up Node 24 after the gate has already run on the
22.12 engines floor. Moving the whole job to "the latest 22" looks like it should work and does
not, with an OIDC error that never mentions a version. There is a guard step that checks the npm
version and says so plainly.

### What the repository needs, once

- An npm organisation named `gravadigital`, with the account that publishes as a member.
- A GitHub Environment named **`npm`** (Settings → Environments). It holds no secrets. The name is
  part of the credential once OIDC is on: the trusted publisher is bound to it, so a workflow
  running without it cannot publish. It is also where you would add a required reviewer if you
  want a human to approve releases.
- `main` and `dev` protected, with the CI checks required. Note that branch protection on `main`
  blocks the direct push in step 1 above — if you turn it on, do the merge and the version bump in
  a pull request and tag the merge commit instead.
