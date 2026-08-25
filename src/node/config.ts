import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { DEFAULT_ISSUER, ENV } from '../config.ts';
import { JikuError } from '../errors.ts';
import { configFile } from './store.ts';

/** The identity provider half of the config file. */
export interface ZitadelConfig {
  /** The Zitadel instance, e.g. `https://id.grava.io`. */
  issuer?: string;
  /** Client id of a Native app with the Device Code grant, for an interactive login. */
  clientId?: string;
  /**
   * The Zitadel project.
   *
   * It is what puts the ROLES in the token, and the callout reads the role to decide what you may
   * do — so a token minted without it connects to nothing.
   */
  projectId?: string;
  /**
   * A service account JSON key, for unattended use. When set, authenticate as that machine user
   * instead of as a person.
   */
  keyFile?: string;
}

/**
 * The shape of `~/.config/jiku/config.yaml`, the conventional place a jiku client's settings live
 * on a machine.
 *
 * Reading the shared file rather than inventing a private one is the point: everything on the
 * machine then points at the same bus, the same instance and the same issuer.
 */
export interface FileConfig {
  servers?: string;
  instance?: string;
  creds?: string;
  /** A duration string (`15s`, `1m30s`) or a plain number of milliseconds. */
  timeout?: string | number;
  name?: string;
  zitadel?: ZitadelConfig;
}

/**
 * Reads the YAML config file, applies environment overrides, and fills in defaults.
 *
 * A missing file is not an error: the environment alone is a perfectly good way to configure
 * this, and it is how a containerised service normally does it.
 *
 * The result is NOT a `ConnectOptions` — it has no `auth`, because choosing an identity is the
 * caller's decision and this function will not guess at it. Build the token source you want and
 * pass the rest of this through.
 *
 * ```ts
 * const config = await loadConfig();
 * const client = await connect({ ...config, auth });
 * ```
 */
export async function loadConfig(path?: string): Promise<LoadedConfig> {
  const file = path ?? configFile();
  let parsed: FileConfig = {};

  let raw: string | undefined;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new JikuError(`jiku: reading ${file}`, { cause: error });
    }
    // Nothing to load. The environment and the defaults take over.
  }

  if (raw !== undefined) {
    let document: unknown;
    try {
      document = parseYaml(raw);
    } catch (cause) {
      throw new JikuError(`jiku: parsing ${file}`, { cause });
    }
    if (document !== null && document !== undefined) {
      if (typeof document !== 'object' || Array.isArray(document)) {
        throw new JikuError(`jiku: ${file} does not contain a YAML mapping`);
      }
      parsed = normalizeKeys(document as Record<string, unknown>);
    }
  }

  const env = process.env;
  const zitadel: ZitadelConfig & { issuer: string } = {
    issuer: DEFAULT_ISSUER,
    ...parsed.zitadel,
    ...pick('issuer', env[ENV.issuer] ?? parsed.zitadel?.issuer ?? DEFAULT_ISSUER),
    ...pick('clientId', env[ENV.clientId] ?? parsed.zitadel?.clientId),
    ...pick('projectId', env[ENV.projectId] ?? parsed.zitadel?.projectId),
    ...pick('keyFile', expandHome(env[ENV.keyFile] ?? parsed.zitadel?.keyFile)),
  };

  return {
    ...pick('servers', env[ENV.servers] ?? parsed.servers),
    instance: env[ENV.instance] ?? parsed.instance ?? 'dev',
    ...pick('credsFile', expandHome(env[ENV.creds] ?? parsed.creds)),
    ...pick('timeoutMs', parseTimeout(env[ENV.timeout] ?? parsed.timeout)),
    ...pick('name', parsed.name),
    zitadel,
    path: raw === undefined ? undefined : file,
  };
}

/**
 * What {@link loadConfig} returns: connect options minus the identity, plus the Zitadel block.
 *
 * `instance` and `zitadel.issuer` are NOT optional here even though they are optional in the
 * file, because loadConfig applies a default to both. A type that hedged about them would push
 * a `?? 'dev'` into every caller for a value that is always there.
 */
export interface LoadedConfig {
  servers?: string | undefined;
  instance: string;
  credsFile?: string | undefined;
  timeoutMs?: number | undefined;
  name?: string | undefined;
  zitadel: ZitadelConfig & { issuer: string };
  /** The file the settings came from, or `undefined` when none existed. */
  path: string | undefined;
}

/**
 * Accepts both the snake_case the YAML file uses and the camelCase this package's types use.
 *
 * The file's keys are `client_id` and `project_id`. Rejecting those in favour of camelCase would
 * mean a second config file for one machine.
 */
function normalizeKeys(document: Record<string, unknown>): FileConfig {
  const zitadelRaw = (document['zitadel'] ?? {}) as Record<string, unknown>;
  const config: FileConfig = {
    ...pick('servers', asString(document['servers'])),
    ...pick('instance', asString(document['instance'])),
    ...pick('creds', asString(document['creds'])),
    ...pick('name', asString(document['name'])),
    zitadel: {
      ...pick('issuer', asString(zitadelRaw['issuer'])),
      ...pick('clientId', asString(zitadelRaw['client_id'] ?? zitadelRaw['clientId'])),
      ...pick('projectId', asString(zitadelRaw['project_id'] ?? zitadelRaw['projectId'])),
      ...pick('keyFile', asString(zitadelRaw['key_file'] ?? zitadelRaw['keyFile'])),
    },
  };
  const timeout = document['timeout'];
  if (typeof timeout === 'string' || typeof timeout === 'number') {
    config.timeout = timeout;
  }
  return config;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pick<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Parses a timeout written either as milliseconds or as a duration string.
 *
 * The config file spells it `timeout: 15s`, so that spelling has to work. A bare number is read
 * as milliseconds, which is what a JavaScript caller would mean by one.
 */
export function parseTimeout(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    return value > 0 ? value : undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  const units: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    µs: 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  const pattern = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(trimmed)) !== null) {
    matched = true;
    total += Number(match[1]) * (units[match[2] as string] as number);
  }
  if (!matched) {
    throw new JikuError(
      `jiku: ${JSON.stringify(value)} is not a duration. Write it as milliseconds (15000) or ` +
        'as a duration string (15s, 1m30s).',
    );
  }
  return total;
}

/**
 * Resolves a leading `~`, which people write in config files and which the OS does not expand
 * for us.
 */
export function expandHome(path: string | undefined): string | undefined {
  if (!path?.startsWith('~')) {
    return path;
  }
  const home = homedir();
  if (path === '~') {
    return home;
  }
  if (path.startsWith('~/')) {
    return join(home, path.slice(2));
  }
  // `~user/...` is a shell feature this does not implement; leaving it alone beats guessing.
  return isAbsolute(path) ? path : path;
}
