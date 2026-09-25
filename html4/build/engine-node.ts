// The Engine api.ts needs, over duckdb-wasm's node build: the same
// duckdb-eh.wasm the browser runs, so the build computes what the analyzer
// would. The only code in the build that touches Arrow results.

import { join } from "node:path";
import { createDuckDB, NODE_RUNTIME, ConsoleLogger, LogLevel } from "@duckdb/duckdb-wasm/blocking";
import type { Engine } from "mlog-sql";

const DIST = join(import.meta.dir, "..", "node_modules", "@duckdb", "duckdb-wasm", "dist");

export interface NodeEngine {
    readonly engine: Engine;
    /** Free the database. The engine is unusable after. */
    close(): void;
}

export async function nodeEngine(): Promise<NodeEngine> {
    const db = await createDuckDB(
        {
            mvp: { mainModule: join(DIST, "duckdb-mvp.wasm"), mainWorker: join(DIST, "duckdb-node-mvp.worker.cjs") },
            eh: { mainModule: join(DIST, "duckdb-eh.wasm"), mainWorker: join(DIST, "duckdb-node-eh.worker.cjs") },
        },
        new ConsoleLogger(LogLevel.ERROR),
        NODE_RUNTIME,
    );
    await db.instantiate();
    return {
        engine: {
            registerFileBuffer: async (name, bytes) => { db.registerFileBuffer(name, bytes); },
            dropFile: async (name) => { db.dropFile(name); },
            connect: async () => {
                const c = db.connect();
                return { query: async (sql) => c.query(sql).toArray().map((r) => r.toJSON()) };
            },
        },
        close: () => db.reset(),
    };
}
