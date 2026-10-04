/// <reference path="./sql.d.ts" />
// The package entry point (package.json "exports"). It hides the load steps -- buffer
// names, session variables, one connection, the transaction, ICU -- and hands
// back typed rows from the views. The views stay the source of truth: every
// query here is a SELECT over one view, and no join is written in TypeScript.
//
// Input is a stream of plain mlog bytes per trace (the caller removes gzip), so
// a fetch body, a dropped File, a Bun file, or later a WebSocket all fit, and no
// whole file is ever held in one buffer. The exception is a trace from stock
// moq-rs: recovering its stream ids needs the whole trace at once.
//
// One capture per engine. The tables belong to the database, and group_id
// overlaps between runs, so two captures in one database join wrongly without
// any error. openCapture refuses an engine that already holds traces.

import schemaSql from "./schema.sql" with { type: "text" };
import loadSql from "./load.sql" with { type: "text" };
import recoverSql from "./recover.sql" with { type: "text" };
import {
    CaptureError, QUERIES, col, onEngine, pickDistribution, recordChunks, sqlString, validateRows,
    type Columns, type QuerySpec,
} from "./api-internal";
import { withStreamIds } from "./recover-stream-ids";
import type { Capture, CaptureOptions, Conn, Engine, TraceSource } from "./mlog-sql.d.ts";

// The public types are declared once, in the header; api.ts implements them.
export type * from "./mlog-sql.d.ts";
export { CaptureError, RECOVERED_DWELL } from "./api-internal";

// --- loading ----------------------------------------------------------------

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

// Buffer names are internal and never come from input. The counter keeps two
// captures in one page from registering the same name.
let bufferSeq = 0;

/** mlog-sql.d.ts documents this; load failures are wrapped in loadTrace, the
 *  rest of the engine's errors by onEngine. */
export async function openCapture(
    engine: Engine,
    traces: readonly TraceSource[],
    options: CaptureOptions = {},
): Promise<Capture> {
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const conn = await onEngine(async () => {
        const c = await engine.connect();
        await c.query(schemaSql);
        return c;
    });

    const held = await onEngine(async () => validateRows("openCapture", {
        sql: "",
        columns: { n: col("INTEGER", false) },
    }, await conn.query("SELECT count(*)::INTEGER AS n FROM trace")));
    if ((held[0]?.n ?? 0) > 0) throw new CaptureError({ kind: "engine-used" });

    for (const t of traces) await loadTrace(engine, conn, t, chunkBytes);

    // Lines up the relay's traces that logged no reference_time. It needs
    // every trace, so it runs once, here.
    await onEngine(async () => {
        try {
            await conn.query(recoverSql);
        } catch (e) {
            await conn.query("ROLLBACK").catch(() => undefined);
            throw e;
        }
    });

    const run = <C extends Columns>(name: string, spec: QuerySpec<C>) =>
        onEngine(async () => validateRows(name, spec, await conn.query(spec.sql)));

    // Every distribution comes from one pass over the samples, so the first
    // call runs both queries and the rest reuse the rows: the capture does not
    // change after loading. A failed pass is forgotten, so the next call retries.
    // One after the other, not together: the connection runs one query at a
    // time, and a caller following progress hears the first end before the
    // second starts.
    const runDistributions = async (onQuery: (done: number, of: number) => void) => {
        const summary = await run("distributionSummary", QUERIES.distributionSummary);
        onQuery(1, 2);
        const bins = await run("distributionBin", QUERIES.distributionBin);
        onQuery(2, 2);
        return [summary, bins] as const;
    };
    let distributions: ReturnType<typeof runDistributions> | undefined;
    const distributionRows = (onQuery: (done: number, of: number) => void = () => {}) =>
        distributions ??= runDistributions(onQuery).catch((e: unknown) => {
            distributions = undefined;
            throw e;
        });

    return {
        distribution: async (measure, track) => {
            const [summary, bins] = await distributionRows();
            return pickDistribution(summary, bins, measure, track);
        },
        prepareDistributions: async (onQuery) => { await distributionRows(onQuery); },
        legSummary: () => run("legSummary", QUERIES.legSummary),
        trust: () => run("trust", QUERIES.trust),
        coverage: () => run("coverage", QUERIES.coverage),
        recovery: () => run("recovery", QUERIES.recovery),
        jitterSummary: () => run("jitterSummary", QUERIES.jitterSummary),
        jitterSeries: () => run("jitterSeries", QUERIES.jitterSeries),
        relaySeries: () => run("relaySeries", QUERIES.relaySeries),
        objectBitrateSummary: () => run("objectBitrateSummary", QUERIES.objectBitrateSummary),
        objectBitrateSeries: () => run("objectBitrateSeries", QUERIES.objectBitrateSeries),
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
        // A trace from stock moq-rs has no stream ids. withStreamIds holds such
        // a trace whole and recovers them; any other trace passes through.
        for await (const bytes of withStreamIds(recordChunks(t.stream, chunkBytes), chunkBytes)) {
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
