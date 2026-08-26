# Examples

Three programs, three identities, three runtimes. Each one is complete and runnable.

| Example                                 | Identity                          | Runs on   |
| --------------------------------------- | --------------------------------- | --------- |
| [`quickstart/`](quickstart/main.ts)     | a person, through the device flow | Node      |
| [`service-user/`](service-user/main.ts) | a Zitadel machine user key        | Node      |
| [`browser/`](browser/main.js)           | a token the page already holds    | a browser |

## Running the Node ones

They read `~/.config/jiku/config.yaml` for the bus URL, the instance, the sentinel creds and the
Zitadel settings. See [Configuration](../README.md#configuration) for what goes in it and the
environment variables that override it.

The quickstart opens a browser the first time and keeps the session afterwards; the service-user
example needs no browser at all.

```sh
node --experimental-strip-types examples/quickstart/main.ts

JIKU_KEY_FILE=/etc/jiku/service-account.json \
  node --experimental-strip-types examples/service-user/main.ts
```

On Node 24 the flag is unnecessary; on 22 it is what enables type stripping.

## Running the browser one

```sh
npx esbuild examples/browser/main.js --bundle --format=esm --outfile=examples/browser/bundle.js
npx serve examples/browser
```

It needs three things the other two do not: a NATS `websocket` listener to connect to, the
sentinel creds inlined (safe — see the comment in the file, and the README), and an access token
the page obtained through its own login.
