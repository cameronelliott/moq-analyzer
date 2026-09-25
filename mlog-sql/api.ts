/// <reference path="./sql.d.ts" />
// The package entry point (package.json "exports"). It hides the load steps -- buffer
// names, session variables, one connection, the transaction, ICU -- and hands
// back typed rows from the views. The views stay the source of truth: every
// query here is a SELECT over one view, and no join is written in TypeScript.
//
// Input is a stream of plain mlog bytes per trace (the caller removes gzip), so
// a fetch body, a dropped File, a Bun file, or later a WebSocket all fit, and no
// whole file is ever held in one buffer.
//
// One capture per engine. The tables belong to the database, and group_id
// overlaps between runs, so two captures in one database join wrongly without
// any error. openCapture refuses an engine that already holds traces.

import schemaSql from "./schema.sql" with { type: "text" };
import loadSql from "./load.sql" with { type: "text" };
import {
    CaptureError, QUERIES, col, recordChunks, sqlString, validateRows,
    type Columns, type QuerySpec, type Row,
} from "./api-internal";

export { CaptureError, type CaptureFailure } from "./api-internal";

// --- what the caller supplies -----------------------------------------------

/** One connection. The adapter turns duckdb-wasm's Arrow result into plain
 *  rows (`toArray().map(r => r.toJSON())`); api.ts checks them. */
export interface Conn {
    query(sql: string): Promise<unknown[]>;
}

/** The part of a duckdb-wasm database api.ts uses. The browser's AsyncDuckDB
 *  and the node build both fit behind a few lines of adapter. */
export interface Engine {
    registerFileBuffer(name: string, bytes: Uint8Array): Promise<void>;
    dropFile(name: string): Promise<void>;
    connect(): Promise<Conn>;
}

export interface TraceSource {
    /** Becomes trace.filename: the trace's identity, so unique per capture. */
    readonly name: string;
    /** Connection id. The only thing that ties a connection's two traces together. */
    readonly cid: string;
    /** Plain mlog bytes, gzip already removed. */
    readonly stream: ReadableStream<Uint8Array>;
}

export interface CaptureOptions {
    /** Bytes per load chunk. Smaller means less memory, more per-chunk work. */
    readonly chunkBytes?: number;
}

// --- what comes back --------------------------------------------------------

// The SQL and column specs live in api-internal.ts as QUERIES; these row types
// are what the caller sees of them.
export type LegSummaryRow = Row<typeof QUERIES.legSummary.columns>;
export type TrustRow = Row<typeof QUERIES.trust.columns>;

export interface Capture {
    legSummary(): Promise<LegSummaryRow[]>;
    trust(): Promise<TrustRow[]>;
}

// --- loading ----------------------------------------------------------------

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

// Buffer names are internal and never come from input. The counter keeps two
// captures in one page from registering the same name.
let bufferSeq = 0;

/**
 * Load every trace, in order, on one connection, and return the queries.
 * Throws CaptureError. After a failure the engine holds a partial load, so
 * the caller discards it and starts a new one.
 */
export async function openCapture(
    engine: Engine,
    traces: readonly TraceSource[],
    options: CaptureOptions = {},
): Promise<Capture> {
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const conn = await engine.connect();
    await conn.query(schemaSql);

    const held = validateRows("openCapture", {
        sql: "",
        columns: { n: col("INTEGER", false) },
    }, await conn.query("SELECT count(*)::INTEGER AS n FROM trace"));
    if ((held[0]?.n ?? 0) > 0) {
        throw new CaptureError({
            kind: "load", trace: "*",
            message: "this engine already holds a capture; use a new engine",
        });
    }

    for (const t of traces) await loadTrace(engine, conn, t, chunkBytes);

    const run = async <C extends Columns>(name: string, spec: QuerySpec<C>) =>
        validateRows(name, spec, await conn.query(spec.sql));

    return {
        legSummary: () => run("legSummary", QUERIES.legSummary),
        trust: () => run("trust", QUERIES.trust),
    };
}

async function loadTrace(engine: Engine, conn: Conn, t: TraceSource, chunkBytes: number) {
    const fail = (message: string) => new CaptureError({ kind: "load", trace: t.name, message });

    let vars: string;
    try {
        vars = `SET VARIABLE trace_name = ${sqlString(t.name)};`
             + ` SET VARIABLE cid = ${sqlString(t.cid)};`;
    } catch (e) {
        throw fail(e instanceof Error ? e.message : String(e));
    }

    let chunks = 0;
    try {
        for await (const bytes of recordChunks(t.stream, chunkBytes)) {
            const src = `mlog-chunk-${bufferSeq++}.jsonl`;
            await engine.registerFileBuffer(src, bytes);
            try {
                // trace_name is spent by every load, so it is set before each chunk.
                await conn.query(`SET VARIABLE src = ${sqlString(src)}; ${vars}`);
                await conn.query(loadSql);
            } finally {
                await engine.dropFile(src);
            }
            chunks++;
        }
    } catch (e) {
        // load.sql opens a transaction; a thrown error leaves it open.
        // ROLLBACK fails when the error came before BEGIN, which is fine.
        await conn.query("ROLLBACK").catch(() => undefined);
        await t.stream.cancel().catch(() => undefined);
        if (e instanceof CaptureError) throw e;
        throw fail(e instanceof Error ? e.message : String(e));
    }
    if (chunks === 0) throw fail("no records in the stream");
}
