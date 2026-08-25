/**
 * The universal entry point: everything in the core plus a WebSocket-only `connect()`.
 *
 * This is what `import { connect } from '@gravadigital/jiku'` resolves to in a browser bundle,
 * and in any runtime that is not Node. It imports nothing from `node:`, so it bundles cleanly.
 *
 * @module
 */
export * from './core.ts';
export { connect } from './transport/ws.ts';
