# Running in a browser

The same client, over a WebSocket. Not a separate implementation, not a subset — one codebase,
two transports.

## How the entry point resolves

`package.json` declares the root export with two conditions:

```jsonc
".": {
  "node":    { "types": "./dist/index.node.d.ts", "default": "./dist/index.node.js" },
  "default": { "types": "./dist/index.ws.d.ts",   "default": "./dist/index.ws.js" }
}
```

Under Node you get a `connect()` that speaks **both** TCP and WebSocket, chosen by the URL scheme.
A browser bundler does not match `node`, so it takes `default` — the **WebSocket-only** build,
which imports nothing from `node:` at all.

`"node"` and not `"browser"` on purpose. `node` is a condition in Node's own resolution spec, so
it is honoured everywhere and never matches in a browser build; `"browser"` is a bundler
convention that Deno, Bun and Cloudflare Workers do not implement, and using it would send those
runtimes down the TCP path. With `default` being the WebSocket build, anything that is not Node
gets the transport that always works.

`node:net` therefore cannot enter a browser bundle. That is verified rather than assumed: the
build asserts that `dist/index.ws.js`'s entire import graph contains zero `node:` specifiers.

Importing `@gravadigital/jiku/node` from a browser bundle is a **resolution error** — that entry
declares only a `node` condition. A hard failure at build time beats a mysterious `node:fs` at
runtime.

## What you need

**A `websocket` listener on the NATS server.** Jiku's deployment has one, with TLS on the same
certificate as the TCP port. Connect to it with `wss://host:port`, not `nats://` — this entry
point rejects a `nats://` URL with a real error rather than a bundling failure, because a browser
cannot open a raw TCP socket.

**The sentinel creds, inlined.** There is no filesystem to read them from, so pass the file's
contents as `creds`. See below on why that is fine.

**An access token.** From your own login; this library does not authenticate anybody in a browser.

```ts
import { connect, anyOf } from '@gravadigital/jiku';
import { tokenGetter } from '@gravadigital/jiku/auth';

const client = await connect({
  servers: 'wss://bus.example.com:8443',
  instance: 'prod',
  creds: SENTINEL_CREDS,
  auth: tokenGetter({ getToken: () => session.accessToken() }),
});

const page = await client.list('tasks', { filter: { state: anyOf('activo') }, limit: 20 });
```

## Shipping the sentinel creds is safe, by construction

Not by convention, and not because nobody will look. The creds file's own JWT carries:

```text
pub.deny: [">"]
sub.deny: [">"]
```

It authorises **literally nothing**. Every permission the connection ends up with is minted by the
auth-callout from the Zitadel token, which is the credential that actually matters and which
belongs to the person using the page. Somebody who extracts the creds from your bundle can open a
connection that may publish nothing and subscribe to nothing.

This is the one credential in this system that can be published, and it was designed that way
precisely so that a browser client is possible.

Two things follow, and they are not negotiable:

**A service-account key is the opposite.** It is a private key that mints tokens for a machine
identity, with no user behind it. `ServiceUser` lives in `@gravadigital/jiku/node` so that putting
one in a browser bundle is not a mistake you can make quietly.

**There is no browser token store.** A refresh token in `localStorage` is readable by every script
on the origin, and a library that shipped one by default would be handing people a footgun. The
application owns its session; `tokenGetter` just asks it for the current token.

## Bundling

Anything that understands package `exports` conditions works — esbuild, Vite, Rollup, webpack 5,
Parcel 2. No aliases, no polyfills, no `resolve.fallback` entries.

```sh
npx esbuild app.js --bundle --format=esm --minify --outfile=bundle.js
```

Measured on this package with esbuild:

|                 | Size      |
| --------------- | --------- |
| minified        | 164 KB    |
| minified + gzip | **49 KB** |

Almost all of that is the NATS client itself, which is published as CommonJS and so tree-shakes
less than an ESM library would. It is worth knowing before you commit: this is a bus client, not a
fetch wrapper.

## What is the same, and what is not

Everything above the transport is identical: subjects, the inbox prefix, envelopes, cursors, the
contract, error classes, `iterate`. The integration suite runs the same protocol tests over both
transports for exactly that reason.

What differs:

|                     | Node                                   | Browser                      |
| ------------------- | -------------------------------------- | ---------------------------- |
| `connect()` accepts | `nats://`, `tls://`, `ws://`, `wss://` | `ws://`, `wss://`            |
| `credsFile`         | reads the path                         | throws — pass `creds`        |
| `ServiceUser`       | yes                                    | no, and cannot be imported   |
| `DeviceFlow`        | yes, with `FileStore`                  | possible, but no store ships |
| `loadConfig`        | yes                                    | no, and cannot be imported   |

## Writes, from a browser

You cannot, and that is policy rather than a limitation of this client. The product roles
authorise **no command**, by the bus permission template and by core's role map. A browser that
needs to write goes through the api over HTTP, which holds the business rules that depend on the
end user.

Attempting one raises `JikuPermissionDenied` in milliseconds — the NATS client correlates the
refusal to the in-flight request, so it does not cost the timeout.

## Other runtimes

Deno, Bun and Cloudflare Workers all take the `default` condition and the WebSocket transport,
and all have a global `WebSocket`. Bun and Deno additionally satisfy the `node` condition through
their Node compatibility layers, in which case they get the TCP build and can use `nats://`.

`wsconnect` accepts a `wsFactory` through the `nats` option if a runtime needs its WebSocket
constructed some particular way.
