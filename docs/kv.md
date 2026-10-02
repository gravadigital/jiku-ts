# The key-value space

Every identity on the bus has a space of its own in one NATS key-value bucket. It can store values
there, read them back and delete them. That is all the space is for: state a service or a person
wants to keep between runs, and caches of things that are expensive to recompute.

```ts
const space = await client.kv(); // binds the bucket, once per client

const revision = await space.put('preferences.theme', 'dark');
const entry = await space.get('preferences.theme'); // undefined on a miss
await space.delete('preferences.theme');

if (entry) {
  console.log(new TextDecoder().decode(entry.value), entry.revision, entry.created);
}
```

Core takes no part in any of this. The query and command planes are request/reply with core.
Here the client talks to JetStream directly, and core never sees a key.

It works the same in a browser: the space goes over the WebSocket connection, with the same
per-identity prefix and the same three grants.

---

## Keys

```text
{instance}.{userId}.{key}

dev.275649063808925701.preferences.theme
prod.387842544790142978.cache.tasks.15
```

| Token      | Value                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| `instance` | `dev` or `prod`, as in every subject                                    |
| `userId`   | the token's `sub`, raw, the same as the second segment of every subject |
| `key`      | whatever the caller chose                                               |

**The caller writes only the last part.** The space adds `{instance}.{userId}.` itself and strips
it from what it returns, so a key under somebody else's id cannot even be written. The real
boundary is the bus, though: the auth-callout grants each identity its own prefix and nothing
wider, so a client that skipped this library would still be refused (see
[Permissions](#permissions)).

**There is no version segment**, unlike the request subjects. `v1` in a subject versions a
protocol. This is storage, and what a value means is up to whoever stored it.

**A key is letters, digits and `- / _ = .`**, with no empty segment. Those are NATS's rules, not
this client's. A key that breaks them is refused locally with `JikuInvalidRequest` and never
reaches the bus. Wildcards are not allowed, which keeps every operation exact.
`assertValidKVKey(key)` checks one before connecting.

---

## What there is, and what there is not

| Operation         | Does                                                                        |
| ----------------- | --------------------------------------------------------------------------- |
| `put(key, value)` | stores the value, replacing what was there, and returns the new revision    |
| `get(key)`        | returns the value, its revision and when it was stored; `undefined` if none |
| `delete(key)`     | removes the value; deleting a key that holds nothing succeeds               |

**No listing, no watching, no history.** Each one needs a consumer on the bucket, which is a wider
grant than three exact subjects. You read a key you already know.

**Values are bytes.** `put` takes a `Uint8Array`, or a string it encodes as UTF-8. `get` always
returns a `Uint8Array`. The format is the caller's business: JSON, text, anything.

**The revision orders writes; it does not count them.** It is the bucket's sequence, and a write to
_any_ key in the bucket moves it.

Every operation takes the same `{ signal, timeoutMs }` options as a request.

---

## How an operation travels

| Operation              | Subject                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| bind the bucket (once) | `$JS.API.STREAM.INFO.KV_JIKU_KV`                                      |
| `put`, `delete`        | `$KV.JIKU_KV.{instance}.{userId}.{key}`                               |
| `get`                  | `$JS.API.DIRECT.GET.KV_JIKU_KV.$KV.JIKU_KV.{instance}.{userId}.{key}` |

`delete` is a write to the same subject as `put`, with a header saying it is a delete. That is how
NATS key-value works, and it means **no permission can allow one without the other**.

`get` puts the key **in the subject**. That is what lets a permission confine reads to one
identity; the server refuses a body naming a different key on this form.

These are the only subjects this client sends. It speaks the protocol over the NATS connection it
already holds, rather than through a general key-value library, precisely so that `get` can never
fall back to a form that takes the key in the body.

---

## Permissions

`requiredKVPermissions(instance)` prints these, and every `JikuKVPermissionDenied` carries them:

```yaml
pub:
  allow:
    - '$JS.API.STREAM.INFO.KV_JIKU_KV'
    - '$KV.JIKU_KV.{instance}.{{user_id}}.>'
    - '$JS.API.DIRECT.GET.KV_JIKU_KV.$KV.JIKU_KV.{instance}.{{user_id}}.>'
sub:
  allow:
    - '_INBOX.{{user_id_hash}}.>' # every template already grants this
```

They go on **every role template that should have the space**. The callout has no catch-all rule
([auth.md](auth.md#what-the-callout-does-with-the-token)), so "every logged-in identity" means
adding them to each template. `{{user_id}}` is the same placeholder the request subjects use, and
it is what makes the space per identity.

### Do not grant the wide forms

Each of these also makes a working space, and that is the danger: nothing fails, and every
identity can read or overwrite every other's entries.

| Grant                               | What it opens                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `$KV.JIKU_KV.>`                     | writing and deleting anybody's entries                                                              |
| `$JS.API.DIRECT.GET.KV_JIKU_KV`     | reading anybody's: this form takes the key in the **body**, which no subject permission can confine |
| `$JS.API.STREAM.MSG.GET.KV_JIKU_KV` | the same, through the admin api                                                                     |
| `$JS.API.>`                         | the whole JetStream admin api, deleting the bucket included                                         |

### A refused subject fails at once

The server drops a publish it refuses and reports the refusal on the connection, never as a reply.
The NATS client correlates that report with the request in flight and rejects it, so a missing
grant fails in milliseconds with `JikuKVPermissionDenied`, its `subject`, and the lines above —
rather than costing the whole timeout and then reading as JetStream not answering.

---

## The bucket

**Jiku's deployment creates the bucket. This client never does.** Binding checks that the bucket
exists and is usable, and nothing more.

| Setting         | Value                   |                                         |
| --------------- | ----------------------- | --------------------------------------- |
| name            | `JIKU_KV`               | fixed: it is in every subject above     |
| `allow_direct`  | **true**                | **required**                            |
| history         | 1                       | recommended                             |
| max value size  | the deployment's choice | the largest single value                |
| max bucket size | the deployment's choice | the total, **shared by every identity** |
| TTL             | the deployment's choice | how long an entry lives; fits a cache   |

```bash
nats kv add JIKU_KV --history 1 --max-value-size 64KiB --max-bucket-size 1GiB --ttl 24h
```

(The sizes and TTL above are placeholders, not a recommendation.)

**Why `allow_direct` is required.** Without it, a NATS client sends a get to
`$JS.API.STREAM.MSG.GET`, which takes the key in the request body and cannot be confined to one
identity. The fix would look like granting that subject, and that would let everyone read
everything. So `client.kv()` refuses a bucket without it, with `JikuNoBucket` and a message that
points at the bucket instead. `nats kv add` sets it by default.

**Why history 1.** Nothing here reads old revisions. With a deeper history, every `put` keeps the
previous values, and they take space nobody can read.

---

## Limits

**There is no per-identity quota.** Every limit belongs to the bucket and is shared by every
identity. One identity can fill the bucket, and then every identity's `put` fails with
`JikuBucketFull` until entries expire under the TTL or are deleted. A real per-identity limit would
need one bucket per identity, created by the deployment, which is a different design from this one.

**This is not a place for secrets.** A value crosses the bus in the clear, and the `bus-observer`
role subscribes to everything.

---

## Errors

| Class                    | Meaning                                                           | Fix                                                   |
| ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `JikuInvalidRequest`     | the key breaks NATS's rules                                       | the message names the character                       |
| `JikuKVPermissionDenied` | the bus refused a subject                                         | add the [grants](#permissions) to the role's template |
| `JikuNoBucket`           | the bucket is missing, has no `allow_direct`, or JetStream is off | the [bucket settings](#the-bucket), on the deployment |
| `JikuValueTooLarge`      | over the bucket's max value size or the server's `max_payload`    | store less under one key                              |
| `JikuBucketFull`         | the bucket reached its total size                                 | wait for the TTL, delete entries, or raise the limit  |
| `JikuNotConnected`       | the client was closed                                             | reconnect                                             |

A miss is not among them: `get` answers `undefined`.

A timeout is a plain `JikuError`, **not** `JikuTimeout`. That class means "no reply from core", and
core is not involved here. The message names the two causes that end in the same silence:
JetStream itself, or a refusal that never reached the request.
