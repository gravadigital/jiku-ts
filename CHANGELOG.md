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
