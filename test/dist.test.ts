import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Guards the properties of the BUILT package that its documentation promises and that no unit
 * test can see: which entry point can reach `node:`, and what the export map actually resolves.
 *
 * These run against dist/, so `npm run build` has to have happened. `npm run check` does that.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const built = existsSync(join(dist, 'index.ws.js'));

/** Follows every relative import from an entry and reports the `node:` specifiers reached. */
function nodeImportsFrom(entry: string): { files: string[]; nodeImports: string[] } {
  const seen = new Set<string>();
  const nodeImports = new Set<string>();

  const walk = (file: string): void => {
    if (seen.has(file) || !existsSync(file)) {
      return;
    }
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+["'](.+?)["']|import\(["'](.+?)["']\)/g)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) {
        continue;
      }
      if (specifier.startsWith('node:')) {
        nodeImports.add(specifier);
      } else if (specifier.startsWith('.')) {
        walk(join(dirname(file), specifier));
      }
    }
  };

  walk(entry);
  return { files: [...seen], nodeImports: [...nodeImports].sort() };
}

describe('the built package', { skip: built ? false : 'run `npm run build` first' }, () => {
  test('the browser entry reaches NOTHING from node:', () => {
    // This is the property that makes the package bundle for a browser with no aliases and no
    // polyfills. A single `node:fs` reaching this graph breaks every browser consumer, and it
    // would do so at THEIR build time, not ours.
    const { files, nodeImports } = nodeImportsFrom(join(dist, 'index.ws.js'));
    assert.ok(files.length > 5, `only walked ${files.length} files; the walk is not working`);
    assert.deepEqual(
      nodeImports,
      [],
      `index.ws.js reaches ${nodeImports.join(', ')} — a browser bundle cannot resolve those`,
    );
  });

  test('the browser entry never pulls in the Node transport', () => {
    const { files } = nodeImportsFrom(join(dist, 'index.ws.js'));
    assert.ok(
      !files.some((file) => file.endsWith('transport/node.js')),
      'the WebSocket build reached the TCP transport, which imports node:net',
    );
    assert.ok(
      !files.some((file) => /[\\/]node[\\/]/.test(file)),
      'the WebSocket build reached the node-only entry point',
    );
  });

  test('the Node entry reaches only what it needs a filesystem for', () => {
    const { nodeImports } = nodeImportsFrom(join(dist, 'index.node.js'));
    assert.deepEqual(nodeImports, ['node:fs/promises'], 'reading credsFile is the only reason');
  });

  test('the node entry point is where the private key and the filesystem live', () => {
    const { nodeImports } = nodeImportsFrom(join(dist, 'node', 'index.js'));
    assert.ok(nodeImports.includes('node:crypto'), 'ServiceUser signs assertions here');
    assert.ok(nodeImports.includes('node:fs/promises'));
  });

  test('every path the export map names exists', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      main: string;
      types: string;
    };

    const paths: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === 'string') {
        if (value.endsWith('.js') || value.endsWith('.d.ts')) {
          paths.push(value);
        }
        return;
      }
      if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(collect);
      }
    };
    collect(pkg.exports);
    paths.push(pkg.main, pkg.types);

    assert.ok(paths.length >= 12, `only found ${paths.length} paths in the export map`);
    for (const path of paths) {
      assert.ok(existsSync(join(root, path)), `${path} is exported but was not built`);
    }
  });

  test('the published sources are ESM, with no CommonJS left in them', () => {
    for (const entry of ['index.node.js', 'index.ws.js', 'core.js', 'client.js']) {
      const source = readFileSync(join(dist, entry), 'utf8');
      assert.ok(!/^\s*(module\.exports|exports\.)/m.test(source), `${entry} emits CommonJS`);
      assert.ok(!/\brequire\s*\(/.test(source), `${entry} calls require()`);
    }
  });

  test('imports name .js, not the .ts they were written as', () => {
    // rewriteRelativeImportExtensions does this. If it ever stops, dist/ is unloadable while the
    // tests, which run the .ts sources, keep passing.
    const source = readFileSync(join(dist, 'core.js'), 'utf8');
    assert.match(source, /from ["']\.\/client\.js["']/, 'extensions were not rewritten');
    assert.ok(!/from ["'][^"']+\.ts["']/.test(source), 'a .ts specifier survived into dist/');
  });

  test('no test or example file was published', () => {
    for (const stray of ['test', 'examples', 'src']) {
      assert.ok(!existsSync(join(dist, stray)), `dist/${stray} should not exist`);
    }
  });
});
