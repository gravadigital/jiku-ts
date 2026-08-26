/**
 * The NATS client library this package is built on, re-exported.
 *
 * Import it from here when your own code also talks to the bus directly. Two copies of
 * `@nats-io/nats-core` in one dependency tree mean two sets of error classes, and
 * `error instanceof PermissionViolationError` then fails against the copy that threw. Taking
 * both from this specifier makes that impossible.
 *
 * @module
 */
export * from '@nats-io/nats-core';
