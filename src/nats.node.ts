/**
 * The NATS client library this package is built on, re-exported, with the Node transport's
 * `connect` alongside it.
 *
 * Import it from here when your own code also talks to the bus directly — see the note in the
 * WebSocket build about why one copy matters.
 *
 * `connect` here is the RAW NATS connect, not this library's. It opens a socket with none of the
 * four things `connect()` from `@gravadigital/jiku` does for you, the inbox prefix included, so
 * a request over it will time out unless you set that yourself.
 *
 * @module
 */
export * from '@nats-io/nats-core';
export { connect } from '@nats-io/transport-node';
