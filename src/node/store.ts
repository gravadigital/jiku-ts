import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Store } from '../auth/device.ts';
import type { Tokens } from '../auth/oidc.ts';
import { JikuError } from '../errors.ts';

/**
 * Where the shared configuration and tokens live, honouring `XDG_CONFIG_HOME`.
 *
 * This is the conventional location for a jiku client's settings and session on a machine, so
 * anything else living there shares one login instead of each sending somebody to the browser.
 */
export function configDir(): string {
  const override = process.env['JIKU_CONFIG_DIR'];
  if (override) {
    return override;
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg) {
    return join(xdg, 'jiku');
  }
  return join(homedir(), '.config', 'jiku');
}

/** The default config path: `$XDG_CONFIG_HOME/jiku/config.yaml`. */
export function configFile(): string {
  return join(configDir(), 'config.yaml');
}

/**
 * The conventional per-instance token file:
 *
 * ```text
 * $XDG_CONFIG_HOME/jiku/tokens-<instance>.json   (or ~/.config/jiku/...)
 * ```
 *
 * It is per instance so a session against dev cannot be mistaken for one against prod.
 */
export function defaultStorePath(instance = 'dev'): string {
  return join(configDir(), `tokens-${instance || 'dev'}.json`);
}

/**
 * Keeps tokens in a JSON file with `0600` permissions.
 *
 * The file holds a refresh token in the clear, which is a real credential: it can mint access
 * tokens until it is revoked or rotated out. The permissions are enforced on every write, and a
 * file found with looser ones is reported rather than silently used — a token readable by every
 * process on the machine is worth knowing about.
 */
export class FileStore implements Store {
  readonly #path: string;
  readonly #onWarning: (message: string) => void;

  constructor(path: string = defaultStorePath(), onWarning?: (message: string) => void) {
    this.#path = path;
    this.#onWarning =
      onWarning ??
      ((message) => {
        console.warn(message);
      });
  }

  location(): string {
    return this.#path;
  }

  async load(): Promise<Tokens | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Nothing stored is not an error: it just means nobody has logged in yet.
        return undefined;
      }
      throw new JikuError(`jiku/auth: reading ${this.#path}`, { cause: error });
    }

    try {
      const info = await stat(this.#path);
      // 0o077 is "any permission for group or other". The file holds a refresh token.
      if ((info.mode & 0o077) !== 0) {
        this.#onWarning(
          `[jiku] ${this.#path} is readable beyond its owner (mode ` +
            `${(info.mode & 0o777).toString(8)}). It holds a refresh token; run ` +
            `\`chmod 600 ${this.#path}\`.`,
        );
      }
    } catch {
      // Not being able to stat a file we just read is not worth failing a login over.
    }

    try {
      return JSON.parse(raw) as Tokens;
    } catch (cause) {
      throw new JikuError(
        `jiku/auth: ${this.#path} is not valid JSON. Delete it and log in again.`,
        { cause },
      );
    }
  }

  async save(tokens: Tokens): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    // mode on writeFile only applies when the file is CREATED, so chmod runs unconditionally
    // afterwards: a file that already existed with looser permissions would otherwise keep them.
    await writeFile(this.#path, `${JSON.stringify(tokens, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.#path, 0o600);
  }
}

/**
 * A {@link Store} that keeps tokens in memory for the life of the process.
 *
 * Useful for tests and for a short-lived script that would rather re-authenticate than leave a
 * refresh token on disk.
 */
export class MemoryStore implements Store {
  #tokens: Tokens | undefined;

  location(): string {
    return '(memory)';
  }

  load(): Promise<Tokens | undefined> {
    return Promise.resolve(this.#tokens);
  }

  save(tokens: Tokens): Promise<void> {
    this.#tokens = tokens;
    return Promise.resolve();
  }
}
