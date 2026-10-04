// duckdb-wasm in a worker, behind mlog-sql's Engine interface.
//
// The worker script and the wasm are self-hosted: Bun copies each into dist/
// and the import gives its URL. Only the EH build is used; every current
// browser has wasm exceptions, so the MVP fallback is 41 MB for nobody.
//
// The wasm is the gzipped copy that `bun run wasm` writes to generated/. The
// page downloads it once, gunzips it, and gives every engine the same blob
// URL, so a second engine costs no download.

import * as duckdb from '@duckdb/duckdb-wasm';
import type { Engine } from 'mlog-sql';
import wasmGzUrl from '../generated/duckdb-eh.wasm.gz' with { type: 'file' };
import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js' with { type: 'file' };
import { fetchWasm, type EngineProgress } from './engine-download';

export interface BrowserEngine {
  readonly engine: Engine;
  /** Stops the worker and frees its memory. mlog-sql takes one capture per engine. */
  terminate(): Promise<void>;
}

// One download for the page. A failed one is forgotten, so the next engine
// tries again.
let wasmUrl: Promise<string> | undefined;

function wasmModule(onProgress: (p: EngineProgress) => void): Promise<string> {
  wasmUrl ??= fetchWasm(wasmGzUrl, (url) => fetch(url),
    (loaded, total) => onProgress({ stage: 'download', loaded, total }))
    .then((blob) => URL.createObjectURL(blob))
    .catch((e: unknown) => {
      wasmUrl = undefined;
      throw e;
    });
  return wasmUrl;
}

/** Starts an engine. `onProgress` hears each stage, and `failed` before a rejection. */
export async function browserEngine(onProgress: (p: EngineProgress) => void = () => {}): Promise<BrowserEngine> {
  let worker: Worker | undefined;
  try {
    const url = await wasmModule(onProgress);
    onProgress({ stage: 'start' });
    worker = new Worker(workerUrl);
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR), worker);
    await db.instantiate(url);
    // mlog-sql's schema needs icu and its loader needs json. duckdb-wasm
    // fetches an extension at first use; fetching both now means a load does
    // not wait for them.
    const warmup = await db.connect();
    await warmup.query('LOAD icu; LOAD json;');
    await warmup.close();
    onProgress({ stage: 'ready' });
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
  } catch (e) {
    worker?.terminate();
    onProgress({ stage: 'failed', message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
