# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): a breaking change to anything exported
from the four entry points moves the **major**, a backwards-compatible addition moves the
**minor**, and a fix moves the **patch**.

Two things are part of the public surface even though they are not exports, and changing either
one is a major: the **shape of the `exports` map** — which specifiers resolve, and to what — and
the **`engines` floor**.

## [Unreleased]

Synced against jiku-go `8ae80e8` (release 1.2.0), reading its `fix/iterator-and-reference-docs`
branch for `docs/reference.md` and the iterator fix, which are not on `dev` yet. Then against
`5f1bf26` (release 1.3.0) on `dev`, for the Refresh Token grant.

### Added

- **Seven error codes**, catching the catalog up from 28 to the 35 core serves. `invalid_date_range`
  and `stage_not_found` arrived with REQ-007; `comment_not_owned` and `activity_not_editable` with
  REQ-011's comment-editing commands. Three are declared with **no current emitter** and are kept
  deliberately, because core keeps them too — `invalid_state_transition` (REQ-012 made requirement
  state transitions free in both directions), `file_not_available` and `invalid_attachment_id`.
  A code that loses its emitter keeps its constant.
- **A drift test for the catalog**, checking both directions against a fixture extracted from
  jiku-go: a code it declares that this client lacks, _and_ a constant here that it no longer
  declares. Checking only the first lets the list grow forever and never shrink, which is how a
  retired code goes unnoticed.
- **The first unit tests for `DeviceFlow`**, which until now only the live integration suite
  touched. One pins that an expired, unrenewable session names the missing grant; the other that
  a store holding nothing does not blame it.
- **Seven tests for `iterate`, `iteratePages` and `all`**, pinning that pagination ends **only**
  on a missing cursor. jiku-go had a defect here — it also stopped on an empty page — which this
  client never had, but which nothing pinned: the shape that triggers it (an empty page that still
  carries a cursor, emitted where the byte budget cuts the reply) cannot be produced by a live
  server on demand, so the integration suite could not reach it.

### Fixed

- **A login that could never be renewed failed a day later with nothing pointing at why.** Zitadel
  issues a refresh token only when the Native app has the **Refresh Token** grant; with Device Code
  alone it drops `offline_access` without an error, `login()` succeeds, and about twenty hours
  later `token()` throws `LoginRequired`. Logging in again only restarted the clock. That
  `LoginRequired` now names the missing grant — still the same class, so `instanceof` callers are
  unaffected, and the wording is not an API. jiku-go marks this `[contract]`.
- **This client told integrators that `offline_access` "is what yields a refresh token"**, in the
  `DeviceFlowOptions` TSDoc and `docs/auth.md`. It is necessary and not sufficient, and believing
  otherwise is exactly how the Zitadel app ends up without the grant. Both, and the `clientId`
  comments in `DeviceFlowOptions` and the Node config, now name both grants; `docs/auth.md` gains
  the symptom in its diagnosis table. `login()` deliberately does not warn on its own — its TSDoc
  tells the caller to check `refresh_token` on what it returns.
- **This client stated a rule that stopped being true.** It claimed the product roles authorise
  every query and **no** command, in seven places including `README.md`, `docs/auth.md` and
  `docs/browser.md`. REQ-007 retired that: `admin` and `user` publish most commands straight to
  the bus, and core's role map has **three tiers per role** — reachable directly, reachable only
  through the api's reserved `actor` envelope, or not at all. `external-user` is the only role for
  which the old sentence still described the outcome. `docs/browser.md` told browser users writes
  were impossible and that this was policy; for an `admin` or `user` token it is not.
- The guarantee moved rather than disappeared, and the docs now say where: a refused write from a
  person arrives as a `JikuFailure` with a code from **core**, not as a `JikuPermissionDenied`
  from the bus. Both paths still exist and callers should handle both.
- The acting-person fields (`creator`, `author`, `editor`) are documented as **optional**: core
  resolves the actor from the caller when they are absent.
- **The command count**, from 20 to 23, in `README.md`, `package.json`'s description, `src/core.ts`
  and a `JikuNoEndpoint` message. REQ-011 added the two comment-editing commands and REQ-007 a
  21st (`week-assigned-times.replace`, `admin` only).

## [1.0.0] - 2026-08-25

The first release, and a stable one: the API below is what 1.x will keep.

### Added

- **`connect()` and `Client`** — request/reply over both planes, with the three things a
  hand-rolled NATS client gets wrong on this bus handled for you: the inbox prefix, the two
  credentials, and a token that survives a reconnect.
- **Reads** — `list`, `get`, `count`, `tags`, `iterate`, `iteratePages`, `all`. Pagination follows
  the cursor and stops only on its absence, which is the only end-of-collection signal this
  protocol has.
- **Filter builders** — `anyOf`, `not`, `gt`, `gte`, `lt`, `lte`, `between`, `range`, `contains`,
  and `parseFilter` for input that arrives as text.
- **The contract** — `contract()`, `describe()`, `resource()`, and local validation
  (`validateQuery`, `assertValidQuery`, `coerce`) against the same whitelists core's validator
  reads, including the three discriminated resources.
- **Typed errors** — `JikuFailure`, `JikuTimeout`, `JikuNoEndpoint`, `JikuPermissionDenied`,
  `JikuInvalidRequest`, `JikuNotConnected`, with `isCode`, `isJikuError` and `hint()`.
- **Authentication** — `tokenGetter` and `staticToken` (universal), `DeviceFlow` (RFC 8628), and
  `ServiceUser` (RFC 7523, Node only). Tokens are refreshed in the background so a reconnect after
  an expiry is not refused.
- **Browser support** — a WebSocket transport, selected by the package's export conditions. The
  browser entry point reaches no `node:` module, which a test asserts against the built output.
- **Node extras** — `loadConfig`, `FileStore` and `MemoryStore`, reading the conventional
  `~/.config/jiku/config.yaml` and keeping the session in
  `~/.config/jiku/tokens-<instance>.json`.

### Notes

- Requires Node ≥ 22.12. The package is ESM only; Node 22.12+ can `require()` it.
- `test/fixtures/inbox-vectors.json` pins inbox hashes observed from a running auth-callout, and
  `test/fixtures/describe.json` is a real `meta.describe` reply captured from a running core.

[Unreleased]: https://github.com/gravadigital/jiku-ts/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/gravadigital/jiku-ts/releases/tag/v1.0.0
