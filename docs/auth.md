# Authenticating

The chain, link by link, and what each link looks like when it breaks.

## Two credentials, and only one of them is a secret

Connecting to Jiku's NATS needs both, and they do completely different jobs.

**The sentinel creds.** A NATS user JWT whose own permissions are `pub.deny: [">"]` and
`sub.deny: [">"]`. It grants **nothing**. It exists so the connection can reach the auth-callout,
and for no other reason. This is what makes it safe to ship in a browser bundle — see
[browser.md](browser.md).

**A Zitadel access token.** _This_ is what mints permissions. The callout validates it, reads the
role, picks a permission template, and returns a user JWT with real subject permissions for that
connection.

So the interesting work of authenticating to Jiku is entirely the work of getting a Zitadel token.

## What the callout does with the token

1. Validates it as a **JWT**, against the issuer's JWKS.
2. Reads the **roles** claim.
3. Matches the role against its rules. **There is no catch-all rule.**
4. Mints a user JWT with subject permissions and an inbox: `sub.allow: _INBOX.{{user_id_hash}}.>`.
5. Publishes an **authentication event** on `{instance}.events.auth`, fire-and-forget, which core
   turns into a row in its `users` table.

Every one of those five steps is a place a connection can die, and the error you get back from
NATS says `Authorization Violation` for all of them.

## The three ways to get a token

### `tokenGetter` — you already have one

```ts
import { tokenGetter } from '@gravadigital/jiku/auth';

const auth = tokenGetter({ getToken: () => session.accessToken() });
```

The general-purpose adapter: a session your own code manages, a secret manager, a sidecar, a
browser that logged its user in through Zitadel's web SDK. The result is cached until a minute
before the token's `exp`, so a callback that does real work is not called on every reconnect, and
concurrent refreshes collapse into one call so a reconnect storm does not become a burst of token
requests.

`staticToken(token)` is the degenerate case: one token, never refreshed. Good for a script, wrong
for anything long-lived — when it expires, the next reconnect is refused.

### `DeviceFlow` — a person at a terminal

RFC 8628. The browser does the authenticating; you get a short code, approve it once, and the
tokens land in a store.

```ts
import { DeviceFlow } from '@gravadigital/jiku/auth';
import { FileStore, defaultStorePath } from '@gravadigital/jiku/node';

const auth = new DeviceFlow({
  issuer: 'https://id.example.com',
  clientId: '987654321098765432@your_project',
  projectId: '987654321098765432',
  store: new FileStore(defaultStorePath('dev')),
});

await auth.login();
```

**`token()` never starts an interactive flow.** It throws `LoginRequired` instead. A call that
silently blocks on a human is the kind of surprise that takes a service down at 3am, so `login()`
is separate and is the only method that waits for anybody.

The client id must be a **Native** app in Zitadel with the **Device Code** grant enabled; without
that grant the token endpoint answers `unauthorized_client`.

`offline_access` is in the default scopes and is what yields a refresh token. Without it, every
expiry means another trip to the browser. Zitadel **rotates** the refresh token on every use, so
the new one is kept; when a response carries none, the previous one is preserved rather than
dropped.

The refresh requests the **same** scope set as the original. It has to: a refresh may request a
subset, and omitting the reserved scopes there returns a renewed token with **no roles claim** —
which connects to nothing, intermittently, only after the first expiry. That is a genuinely
horrible bug to find, which is why the scopes are assembled in one place.

### `ServiceUser` — unattended

RFC 7523 JWT profile. No browser, no refresh token, no stored state: the private key _is_ the
credential and a fresh access token is minted whenever one is needed.

```ts
import { ServiceUser } from '@gravadigital/jiku/node';

const auth = await ServiceUser.fromKeyFile('/etc/jiku/service-account.json', {
  issuer: 'https://id.example.com',
  projectId: '987654321098765432',
});
```

In Zitadel: create a machine user, **set Access Token Type to JWT**, grant it a role in the
project, then add a key to it. The JSON file is downloaded exactly once and cannot be
re-downloaded — only replaced.

The assertion this signs has `iss` and `sub` both set to the machine user's id: the key holder is
asserting its own identity, not acting on somebody else's behalf. Both PEM encodings Zitadel has
used are accepted (PKCS#1 `RSA PRIVATE KEY` and PKCS#8 `PRIVATE KEY`).

`ServiceUser` is in the Node entry point and not in `/auth`, deliberately: a service-account
private key must never reach a browser, and a module layout that makes it impossible is worth more
than a warning in a comment.

## The reserved Zitadel scopes

```text
urn:zitadel:iam:org:projects:roles              puts the roles in the token
urn:zitadel:iam:org:project:id:<id>:aud         puts the project in the `aud` claim
```

Set `projectId` and both are added for you. **This is the field people forget.** The callout
matches its rules on the role, and a token with no roles claim matches nothing.

Zitadel emits roles under two different claim keys — `urn:zitadel:iam:org:project:roles` for every
project and `urn:zitadel:iam:org:project:<id>:roles` for one — and which you get depends on the
request rather than on anything you control. A person's token from the device flow tends to carry
the first, a machine user's the second. `decodeClaims` merges both, because for the purpose it is
read for the distinction is noise. The callout reads the **project-scoped** one when configured
with a project id, precisely so a same-named role in another project cannot match a rule.

## `profile` is not optional, even for a service

The default scopes for `ServiceUser` are `openid` and `profile`, and dropping `profile` breaks
things three services away.

The callout's authentication event carries a **name**, and core **requires** one. A machine user's
name reaches the callout through the userinfo endpoint, which only returns it when `profile` was
requested. So a token minted with `openid` alone produces a nameless event, core discards it, no
row is created in `users`, and every subsequent request is refused with `caller_not_authorized`.

The failure is silent in exactly the wrong places: the bus accepts the connection, the callout
logs a success, and only core's log says `[events] descartado: "name" is required`.

## Tokens and reconnects

The callout evaluates the token at **connect time**, and the resulting permissions live for the
life of the connection — NATS does not re-check. That is fine until the connection drops: a
reconnect re-runs the callout, and a token that expired in the meantime means the reconnect is
**refused**.

The NATS client asks for the token through an authenticator that is **synchronous**, and
JavaScript cannot block there to mint one. So `TokenSource` has two halves:

- `token()` is async. It mints or refreshes.
- `currentToken()` is sync. It returns whatever the last successful `token()` produced, and it is
  what the authenticator hands to the server.

`connect()` awaits `token()` before connecting, and then keeps `currentToken()` fresh on a timer
so a reconnect always has something live to present. That timer is `unref`'d, so it never holds a
Node process open on its own.

If a background refresh fails, the current token still works — but the _next_ reconnect will be
refused, so it belongs in your logs. Pass `onTokenError` to put it there.

## Who can do what

The product roles — `admin`, `user`, `external-user` — authorise **every query and no command**,
enforced by the bus permission template _and_ by core's own role map. Two independent layers,
which both have to agree for that to change.

Three roles grant bus access and authorise **nothing** in core: `internal-app`, `core` and
`bus-observer`. The api works while holding `internal-app` because it is exempt by its `sub`
(core's `CORE_TRUSTED_PUBLISHER_ID`), **not** because of the role — so a second identity given that
same role can do nothing at all.

## Diagnosing a refusal

| Symptom                              | Where it comes from                                       |
| ------------------------------------ | --------------------------------------------------------- |
| `Authorization Violation` on connect | the callout rejected the **token**, not the creds         |
| `JikuPermissionDenied`               | the **bus** refused the publish, by subject               |
| `caller_not_authorized`              | **core** refused, by role or by a missing `users` row     |
| `unknown_caller`                     | core could not resolve the caller's class: no `users` row |
| every request times out              | the **inbox prefix** — but not through this client        |

`caller_not_authorized` has three causes the code cannot tell apart, so `JikuFailure.hint()` names
all three in the order worth checking. The third one is worth knowing about: the very first
request of a brand-new identity can lose a race with its own authentication event, which is
fire-and-forget and unacknowledged. Retrying once distinguishes it from the other two.
