// duckdb-wasm in a worker, behind mlog-sql's Engine interface.
//
// The worker script and the wasm are self-hosted: Bun copies each into dist/
// and the import gives its URL. Only the EH build is used; every current
// browser has wasm exceptions, so the MVP fallback is 41 MB for nobody.

import * as duckdb from '@duckdb/duckdb-wasm';
import type { Engine } from 'mlog-sql';
import wasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm' with { type: 'file' };
import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js' with { type: 'file' };

export interface BrowserEngine {
  readonly engine: Engine;
  /** Stops the worker and frees its memory. mlog-sql takes one capture per engine. */
  terminate(): Promise<void>;
}

export async function browserEngine(): Promise<BrowserEngine> {
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR), worker);
  await db.instantiate(wasmUrl);
  return {
    engine: {
      registerFileBuffer: (name, bytes) => db.registerFileBuffer(name, bytes),
      dropFile: async (name) => { await db.dropFile(name); },
      connect: async () => {
        const conn = await db.connect();
        // Arrow rows to plain objects. mlog-sql checks every row, so they stay unknown here.
        return { query: async (sql) => (await conn.query(sql)).toArray().map((r) => r.toJSON()) };
      },
    },
    terminate: () => db.terminate(),
  };
}
