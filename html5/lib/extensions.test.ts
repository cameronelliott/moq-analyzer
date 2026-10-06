// The duckdb extensions are served from our own site, under the directory
// duckdb asks for: extensions/<duckdb version>/<platform>/. The version is
// written in package.json's `extensions` script. If the duckdb-wasm package
// moves to another duckdb, the engine asks for a directory that is not there
// and never starts. This fails first, and says which version to write.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');

test('the extensions script fetches for the duckdb version and platform the engine is', async () => {
  // The node build of the same package: same duckdb, same answer.
  const duckdb = await import(`${DIST}/duckdb-node-blocking.cjs`);
  const db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: `${DIST}/duckdb-mvp.wasm`, mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs` },
      eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
    },
    new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR), duckdb.NODE_RUNTIME,
  );
  await db.instantiate();
  // One row, two VARCHAR columns; the query above fixes the shape.
  const row = db.connect().query('SELECT version() AS version, (SELECT platform FROM pragma_platform()) AS platform')
    .toArray()[0].toJSON() as { version: string; platform: string };

  // JSON.parse gives `any`; package.json has a scripts object of strings.
  const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  const paths = [...(scripts.extensions ?? '').matchAll(/extensions(?:\.duckdb\.org)?\/(v[\d.]+)\/(\w+)/g)];
  expect(paths.length).toBeGreaterThan(0);
  for (const [, version, platform] of paths) {
    expect([version, platform]).toEqual([row.version, row.platform]);
  }
  // Both extensions mlog-sql needs, and the build copies them into dist/.
  expect(scripts.extensions).toContain('for e in icu json;');
  expect(scripts.build).toContain('cp -r generated/extensions dist/extensions');
  expect(scripts.dev).toContain('cp -r generated/extensions dist/extensions');
}, 60_000);
