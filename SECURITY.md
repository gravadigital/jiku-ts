# Security

## Reporting a vulnerability

Report privately, not in a public issue: **security@grava.digital**, or through GitHub's private
vulnerability reporting on this repository.

Include what you did, what happened, and what you expected. If it involves credentials, say which
kind — the distinction below matters more than usual here.

We will acknowledge within three working days and keep you updated until it is resolved.

## What is and is not a credential in this system

This package handles two things that look alike and are not, and confusing them is the most likely
source of a bad report or a bad decision.

### The sentinel NATS creds — publishable, by design

The file's own JWT carries `pub.deny: [">"]` and `sub.deny: [">"]`. It authorises **nothing**. Its
only job is to let a connection reach the auth-callout, which is what mints real permissions — and
it mints them from the Zitadel token, not from this file.

It is therefore **safe to ship in a browser bundle**, and the browser support in this package
depends on that being true. Finding it in a published bundle is not a vulnerability. Someone who
extracts it can open a connection that may publish nothing and subscribe to nothing.

### A Zitadel access token — the real credential

This is what decides what you may do. It is short-lived, it belongs to a person or a machine user,
and it should never be logged, persisted where it does not need to be, or sent anywhere other than
the bus and the issuer.

This package never logs a token. `decodeClaims` reads the payload **without verifying the
signature**, for three local, non-security purposes only: the caller's own `sub`, the local expiry
check, and telling a person which roles they hold. Whoever validates a token is the auth-callout.
Do not use `decodeClaims` for an authorisation decision.

### A service-account key — a private key

The JSON file Zitadel produces for a machine user contains an RSA private key. It mints tokens for
that identity with no user behind it, and Zitadel will not re-issue it — only replace it.

`ServiceUser` lives in `@gravadigital/jiku/node` and **cannot be imported into a browser bundle**.
That is a deliberate module-layout decision, not an oversight: putting one in front-end code should
be impossible rather than merely discouraged.

## Stored tokens

`FileStore` writes `0600` and re-applies those permissions on every write, because
`writeFile`'s `mode` only applies when a file is created — a file left world-readable by something
else would otherwise keep those permissions. Reading a file with looser permissions prints a
warning rather than failing.

There is **no browser token store in this package**, deliberately. A refresh token in
`localStorage` is readable by every script on the origin, and shipping one by default would hand
people a footgun. A browser application owns its session and passes the current token through
`tokenGetter`.

## Supported versions

The latest minor release of the current major receives fixes.

## Dependencies

Three, all direct: `@nats-io/nats-core` and `@nats-io/transport-node` (the NATS client, Apache-2.0)
and `yaml` (config parsing in the Node entry only, ISC). CI runs `npm audit` on every push.
