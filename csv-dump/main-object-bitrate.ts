// Loads a capture's mlogs through mlog-sql's public API and writes the object
// bitrate series as CSV.
//   bun main.ts [capture-dir] [out.csv]
// The capture dir holds <cid>_<client|server>.mlog.gz files. Defaults to
// a1's real-6pop capture.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createDuckDB, NODE_RUNTIME, ConsoleLogger, LogLevel } from "@duckdb/duckdb-wasm/blocking";
import { CaptureError, openCapture, type Engine, type ObjectBitrateSeriesRow, type ObjectBitrateSummaryRow, type TraceSource } from "mlog-sql";
import { csvLines } from "./csv";

const DIST = join(import.meta.dir, "node_modules", "@duckdb", "duckdb-wasm", "dist");
const captureDir = process.argv[2] ?? join(import.meta.dir, "..", "..", "a1", "data", "real-6pop");
const outPath = process.argv[3] ?? "real-6pop-object-bitrate-series.csv";
const summaryPath = outPath.replace(/(-series)?\.csv$/, "") + "-summary.csv";

const COLUMNS = [
    "cid", "vantage_point", "direction", "scope", "track_namespace", "track_name",
    "t_s", "objects", "bytes", "kbit_s",
] as const satisfies readonly (keyof ObjectBitrateSeriesRow)[];

const SUMMARY_COLUMNS = [
    "cid", "vantage_point", "direction", "scope", "track_namespace", "track_name",
    "bytes", "seconds", "span_s",
    "mean_kbit_s", "p5_kbit_s", "median_kbit_s", "p95_kbit_s", "max_kbit_s",
] as const satisfies readonly (keyof ObjectBitrateSummaryRow)[];

/** Each fails typecheck when its row type gains a column the list lacks. */
export type ColumnsCoverRows = [
    [Exclude<keyof ObjectBitrateSeriesRow, (typeof COLUMNS)[number]>] extends [never] ? true : never,
    [Exclude<keyof ObjectBitrateSummaryRow, (typeof SUMMARY_COLUMNS)[number]>] extends [never] ? true : never,
];
export const columnsCoverRows: ColumnsCoverRows = [true, true];

async function nodeEngine(): Promise<Engine> {
    const db = await createDuckDB(
        {
            mvp: { mainModule: `${DIST}/duckdb-mvp.wasm`, mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs` },
            eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
        },
        new ConsoleLogger(LogLevel.ERROR),
        NODE_RUNTIME,
    );
    await db.instantiate();
    return {
        registerFileBuffer: async (name, bytes) => { db.registerFileBuffer(name, bytes); },
        dropFile: async (name) => { db.dropFile(name); },
        connect: async () => {
            const c = db.connect();
            return { query: async (sql) => c.query(sql).toArray().map((r) => r.toJSON()) };
        },
    };
}

function sources(dir: string): TraceSource[] {
    const files = readdirSync(dir).filter((f) => f.endsWith(".mlog.gz")).sort();
    if (files.length === 0) throw new Error(`no *.mlog.gz in ${dir}`);
    return files.map((f) => ({
        name: f.replace(/\.gz$/, ""),
        cid: f.split("_")[0]!,
        stream: Bun.file(join(dir, f)).stream().pipeThrough(new DecompressionStream("gzip")),
    }));
}

const t0 = performance.now();
let rows: ObjectBitrateSeriesRow[];
let summary: ObjectBitrateSummaryRow[];
try {
    const cap = await openCapture(await nodeEngine(), sources(captureDir));
    rows = await cap.objectBitrateSeries();
    summary = await cap.objectBitrateSummary();
} catch (e) {
    // mlog-sql throws CaptureError only; anything else came from this file.
    if (!(e instanceof CaptureError)) throw e;
    console.error(`mlog-sql failed (${e.failure.kind}): ${e.message}`);
    process.exit(1);
}

await Bun.write(outPath, [...csvLines(COLUMNS, rows)].join(""));
await Bun.write(summaryPath, [...csvLines(SUMMARY_COLUMNS, summary)].join(""));

console.log(`${rows.length} rows -> ${outPath}, ${summary.length} rows -> ${summaryPath}`
    + ` in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// kbit/s to one decimal; NULL (log too short, or no interior data) as "-".
const kbit = (v: number | null) => (v === null ? "-" : v.toFixed(1));
console.table(summary.map((r) => ({
    cid: r.cid.slice(0, 8),
    vp: r.vantage_point,
    dir: r.direction,
    scope: r.scope,
    track: r.scope === "all" ? "" : `${r.track_namespace ?? "?"}/${r.track_name ?? "?"}`,
    MB: (r.bytes / 1e6).toFixed(2),
    span_s: r.span_s,
    mean: kbit(r.mean_kbit_s),
    p5: kbit(r.p5_kbit_s),
    median: kbit(r.median_kbit_s),
    p95: kbit(r.p95_kbit_s),
    max: kbit(r.max_kbit_s),
})));
