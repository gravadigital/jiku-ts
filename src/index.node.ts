/**
 * The Node entry point: everything in the core plus a `connect()` that speaks both TCP and
 * WebSocket, choosing by the URL scheme.
 *
 * This is what `import { connect } from '@gravadigital/jiku'` resolves to under Node, Bun and
 * Deno's Node compatibility. A browser bundler matches the `default` condition instead and gets
 * the WebSocket-only build, so `node:net` never enters a browser bundle.
 *
 * @module
 */
export * from './core.ts';
export { connect } from './transport/node.ts';
