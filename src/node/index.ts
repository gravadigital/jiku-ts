/**
 * The Node-only half of the package: everything that needs a filesystem or a private key.
 *
 * It is a separate entry point rather than a set of conditional imports so that the root and
 * `/auth` entries stay free of `node:` specifiers and bundle cleanly for a browser. Importing
 * this from a browser bundle is a resolution error, which is a much better failure than a
 * mysterious `node:fs` at runtime.
 *
 * ```ts
 * import { connect } from '@gravadigital/jiku';
 * import { ServiceUser, loadConfig } from '@gravadigital/jiku/node';
 *
 * const config = await loadConfig();
 * const auth = await ServiceUser.fromKeyFile(config.zitadel.keyFile!, {
 *   issuer: config.zitadel.issuer!,
 *   projectId: config.zitadel.projectId,
 * });
 *
 * const client = await connect({ ...config, auth });
 * ```
 *
 * @module
 */

export { ServiceUser } from './service-user.ts';
export type { ServiceAccountKey, ServiceUserOptions } from './service-user.ts';

export { FileStore, MemoryStore, configDir, configFile, defaultStorePath } from './store.ts';

export { expandHome, loadConfig, parseTimeout } from './config.ts';
export type { FileConfig, LoadedConfig, ZitadelConfig } from './config.ts';
