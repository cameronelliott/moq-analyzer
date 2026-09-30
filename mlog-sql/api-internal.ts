// The parts of api.ts that need their own tests: cutting a byte stream into
// whole-record chunks, and checking query rows against a column spec. Private
// to mlog-sql -- html4 imports api.ts only, which re-exports what it needs.

import type { CaptureFailure, Distribution, Measure, Track } from "./mlog-sql.d.ts";

// --- errors -----------------------------------------------------------------

export class CaptureError extends Error {
    readonly failure: CaptureFailure;
    constructor(failure: CaptureFailure, options?: ErrorOptions) {
        super(describe(failure), options);
        this.name = "CaptureError";
        this.failure = failure;
    }
}

function describe(f: CaptureFailure): string {
    switch (f.kind) {
        case "load": return `load failed for "${f.trace}": ${f.message}`;
        case "row": return `${f.query} row ${f.row}, column ${f.column}: ${f.message}`;
        case "engine": return `engine failed: ${f.message}`;
        case "engine-used": return "this engine already holds a capture; use a new engine";
    }
}

/** Anything the engine throws becomes a CaptureError, so callers catch one type. */
export async function onEngine<T>(step: () => Promise<T>): Promise<T> {
    try {
        return await step();
    } catch (e) {
        if (e instanceof CaptureError) throw e;
        throw new CaptureError(
            { kind: "engine", message: e instanceof Error ? e.message : String(e) },
            { cause: e });
    }
}

// --- chunking ---------------------------------------------------------------

const LF = 0x0a;

/**
 * Cut a stream of mlog bytes into chunks of whole records, each at least
 * `target` bytes where the input allows. Cuts only after an LF, so a record is
 * never split: JSON escapes newlines inside strings, so a raw LF only ever ends
 * a record, and no text decoding is needed to find one. The last chunk may lack
 * a trailing LF; read_csv takes that as a final line.
 *
 * A chunk can run past `target` by up to one incoming piece, or by one record
 * longer than `target`. Memory stays bounded by that, not by the file.
 */
export async function* recordChunks(
    stream: ReadableStream<Uint8Array>,
    target: number,
): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    let parts: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.length === 0) continue;

            const lf = size + value.length < target ? -1 : value.lastIndexOf(LF);
            if (lf < 0) {
                parts.push(value);
                size += value.length;
                continue;
            }
            parts.push(value.subarray(0, lf + 1));
            yield concat(parts);
            const rest = value.subarray(lf + 1);
            parts = rest.length > 0 ? [rest] : [];
            size = rest.length;
        }
        if (size > 0) yield concat(parts);
    } finally {
        reader.releaseLock();
    }
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

// --- rows -------------------------------------------------------------------

/** The DuckDB types a query may hand back. Deliberately no BIGINT: it arrives
 *  as `bigint`, so each query casts to INTEGER or DOUBLE in SQL instead. */
export type SqlType = "VARCHAR" | "INTEGER" | "DOUBLE";

export interface Column {
    readonly type: SqlType;
    readonly nullable: boolean;
    /** When present, the only values the column may hold (besides NULL). */
    readonly values?: readonly (string | number)[];
}

export type Columns = Readonly<Record<string, Column>>;

type Value<C extends Column> =
    | (C extends { readonly values: readonly (infer V)[] } ? V
        : C["type"] extends "VARCHAR" ? string : number)
    | (C["nullable"] extends true ? null : never);

export type Row<C extends Columns> = { readonly [K in keyof C]: Value<C[K]> };

/** One query and the exact columns it must return, in order. The row type, the
 *  row check, and the DESCRIBE contract test all come from this one object. */
export interface QuerySpec<C extends Columns> {
    readonly sql: string;
    readonly columns: C;
}

type Js<T extends SqlType> = T extends "VARCHAR" ? string : number;

/** A column. `values`, when given, is the fixed set the view can produce. */
export function col<T extends SqlType, N extends boolean>(type: T, nullable: N): { type: T; nullable: N };
export function col<T extends SqlType, N extends boolean, const V extends readonly Js<T>[]>(
    type: T, nullable: N, values: V): { type: T; nullable: N; values: V };
export function col(type: SqlType, nullable: boolean, values?: readonly (string | number)[]) {
    return values === undefined ? { type, nullable } : { type, nullable, values };
}

/** Check rows from the engine against a spec. Throws on the first mismatch. */
export function validateRows<C extends Columns>(
    query: string,
    spec: QuerySpec<C>,
    rows: unknown[],
): Row<C>[] {
    const names = Object.keys(spec.columns);
    return rows.map((raw, i) => {
        const fail = (column: string, message: string) =>
            new CaptureError({ kind: "row", query, row: i, column, message });

        if (typeof raw !== "object" || raw === null) throw fail("*", `not an object: ${String(raw)}`);
        const got = Object.keys(raw);
        const extra = got.filter((k) => !names.includes(k));
        if (extra.length > 0) throw fail(extra.join(", "), "not in the spec");

        const out: Record<string, string | number | null> = {};
        for (const name of names) {
            const c = spec.columns[name];
            if (c === undefined) throw fail(name, "spec has no such column");
            if (!(name in raw)) throw fail(name, "missing");
            const v: unknown = Reflect.get(raw, name);
            out[name] = checkValue(v, c, (m) => fail(name, m));
        }
        // Every column of the spec was checked above for type and nullability,
        // and no other key is present, so this is the shape Row<C> describes.
        return out as Row<C>;
    });
}

function checkValue(v: unknown, c: Column, fail: (m: string) => CaptureError): string | number | null {
    if (v === null || v === undefined) {
        if (c.nullable) return null;
        throw fail(`NULL in a NOT NULL ${c.type} column`);
    }
    const typed = checkType(v, c, fail);
    if (c.values !== undefined && !c.values.includes(typed)) {
        throw fail(`${JSON.stringify(typed)} is not one of ${JSON.stringify(c.values)}`);
    }
    return typed;
}

function checkType(v: unknown, c: Column, fail: (m: string) => CaptureError): string | number {
    if (typeof v === "bigint") {
        throw fail(`BIGINT reached the row (${v}); cast it to ${c.type} in the query`);
    }
    switch (c.type) {
        case "VARCHAR":
            if (typeof v === "string") return v;
            break;
        case "INTEGER":
            if (typeof v === "number" && Number.isInteger(v)) return v;
            break;
        case "DOUBLE":
            if (typeof v === "number") return v;
            break;
    }
    throw fail(`expected ${c.type}, got ${typeof v} ${String(v)}`);
}

// --- queries ----------------------------------------------------------------

// The fixed sets the views produce, from schema.sql: the `leg` view's three
// legs, relay_series's three series, the `direction` ENUM, coverage's sender,
// and object_bitrate_series's grouping.
const LEG_NOS = [1, 2, 3] as const;
const LEGS = ["pub -> relay", "relay dwell", "relay -> sub"] as const;
const RELAY_SERIES = ["relay dwell", "relay egress jitter", "subscriber jitter"] as const;
const DIRECTIONS = ["created", "parsed"] as const;
const SENDERS = ["client", "server", "both"] as const;
const SCOPES = ["all", "track"] as const;
const MEASURES = ["end to end", "relay dwell", "interarrival", "bitrate"] as const;
const UNITS = ["ms", "kbit/s"] as const;

/** Every query api.ts runs, with the exact columns it returns. Casts in the SQL
 *  keep BIGINT out of the rows. api.test.ts DESCRIBEs each one against this. */
export const QUERIES = {
    // The frames are views in schema.sql, where they are explained and tested.
    // Each entry here only selects, casts, and orders.
    legSummary: {
        sql: `SELECT sub_cid,
                     leg_no::INTEGER    AS leg_no,
                     leg,
                     n::INTEGER         AS n,
                     mean_ms::DOUBLE    AS mean_ms,
                     median_ms::DOUBLE  AS median_ms,
                     p95_ms::DOUBLE     AS p95_ms
              FROM leg_summary
              ORDER BY sub_cid, leg_no`,
        columns: {
            sub_cid: col("VARCHAR", false),
            leg_no: col("INTEGER", false, LEG_NOS),
            leg: col("VARCHAR", false, LEGS),
            n: col("INTEGER", false),
            mean_ms: col("DOUBLE", false),
            median_ms: col("DOUBLE", false),
            p95_ms: col("DOUBLE", false),
        },
    },
    jitterSummary: {
        sql: `SELECT sub_cid,
                     leg_no::INTEGER  AS leg_no,
                     leg,
                     n::INTEGER       AS n,
                     mean_ms::DOUBLE  AS mean_ms,
                     p95_ms::DOUBLE   AS p95_ms,
                     p99_ms::DOUBLE   AS p99_ms,
                     max_ms::DOUBLE   AS max_ms
              FROM jitter_summary
              ORDER BY sub_cid, leg_no`,
        columns: {
            sub_cid: col("VARCHAR", false),
            leg_no: col("INTEGER", false, LEG_NOS),
            leg: col("VARCHAR", false, LEGS),
            n: col("INTEGER", false),
            mean_ms: col("DOUBLE", false),
            p95_ms: col("DOUBLE", false),
            p99_ms: col("DOUBLE", false),
            max_ms: col("DOUBLE", false),
        },
    },
    jitterSeries: {
        sql: `SELECT sub_cid,
                     leg_no::INTEGER  AS leg_no,
                     leg,
                     t_s::INTEGER     AS t_s,
                     n::INTEGER       AS n,
                     mean_ms::DOUBLE  AS mean_ms,
                     max_ms::DOUBLE   AS max_ms
              FROM jitter_series
              ORDER BY sub_cid, leg_no, t_s`,
        columns: {
            sub_cid: col("VARCHAR", false),
            leg_no: col("INTEGER", false, LEG_NOS),
            leg: col("VARCHAR", false, LEGS),
            t_s: col("INTEGER", false),
            n: col("INTEGER", false),
            mean_ms: col("DOUBLE", false),
            max_ms: col("DOUBLE", false),
        },
    },
    // One row per dot: dwell and its |D| pooled, subscriber |D| per subscriber.
    relaySeries: {
        sql: `SELECT series,
                     sub_cid,
                     t_s::INTEGER     AS t_s,
                     n::INTEGER       AS n,
                     mean_ms::DOUBLE  AS mean_ms
              FROM relay_series
              ORDER BY series, sub_cid, t_s`,
        columns: {
            series: col("VARCHAR", false, RELAY_SERIES),
            sub_cid: col("VARCHAR", true),   // NULL on the two pooled series
            t_s: col("INTEGER", false),
            n: col("INTEGER", false),
            mean_ms: col("DOUBLE", false),
        },
    },
    // Bytes are DOUBLE: an INTEGER overflows at 2 GB, about two hours of 2 Mbit/s.
    objectBitrateSeries: {
        sql: `SELECT cid,
                     vantage_point,
                     direction::VARCHAR  AS direction,
                     scope,
                     track_namespace,
                     track_name,
                     t_s::INTEGER        AS t_s,
                     objects::INTEGER    AS objects,
                     bytes::DOUBLE       AS bytes,
                     kbit_s::DOUBLE      AS kbit_s
              FROM object_bitrate_series
              ORDER BY cid, vantage_point, direction, scope, track_namespace, track_name, t_s`,
        columns: {
            cid: col("VARCHAR", false),
            vantage_point: col("VARCHAR", false),
            direction: col("VARCHAR", false, DIRECTIONS),
            scope: col("VARCHAR", false, SCOPES),
            track_namespace: col("VARCHAR", true),   // NULL on `all` rows and unresolved tracks
            track_name: col("VARCHAR", true),
            t_s: col("INTEGER", false),
            objects: col("INTEGER", false),
            bytes: col("DOUBLE", false),
            kbit_s: col("DOUBLE", false),
        },
    },
    objectBitrateSummary: {
        sql: `SELECT cid,
                     vantage_point,
                     direction::VARCHAR     AS direction,
                     scope,
                     track_namespace,
                     track_name,
                     bytes::DOUBLE          AS bytes,
                     seconds::INTEGER       AS seconds,
                     span_s::INTEGER        AS span_s,
                     mean_kbit_s::DOUBLE    AS mean_kbit_s,
                     p5_kbit_s::DOUBLE      AS p5_kbit_s,
                     median_kbit_s::DOUBLE  AS median_kbit_s,
                     p95_kbit_s::DOUBLE     AS p95_kbit_s,
                     max_kbit_s::DOUBLE     AS max_kbit_s
              FROM object_bitrate_summary
              ORDER BY cid, vantage_point, direction, scope, track_namespace, track_name`,
        columns: {
            cid: col("VARCHAR", false),
            vantage_point: col("VARCHAR", false),
            direction: col("VARCHAR", false, DIRECTIONS),
            scope: col("VARCHAR", false, SCOPES),
            track_namespace: col("VARCHAR", true),
            track_name: col("VARCHAR", true),
            bytes: col("DOUBLE", false),
            seconds: col("INTEGER", false),
            span_s: col("INTEGER", false),
            // mean: NULL when the end's log is two seconds or shorter. The
            // rest: also NULL when no second of the interior has data.
            mean_kbit_s: col("DOUBLE", true),
            p5_kbit_s: col("DOUBLE", true),
            median_kbit_s: col("DOUBLE", true),
            p95_kbit_s: col("DOUBLE", true),
            max_kbit_s: col("DOUBLE", true),
        },
    },
    // Per connection. `lost` and `outside_window` stay apart: their sum is not loss.
    trust: {
        sql: `SELECT cid,
                     sender_is,
                     sent::INTEGER           AS sent,
                     received::INTEGER       AS received,
                     joined::INTEGER         AS joined,
                     lost::INTEGER           AS lost,
                     outside_window::INTEGER AS outside_window,
                     negative_hops::INTEGER  AS negative_hops
              FROM trust
              ORDER BY cid`,
        columns: {
            cid: col("VARCHAR", false),
            sender_is: col("VARCHAR", true),   // NULL when nothing was sent on the connection
            sent: col("INTEGER", false),
            received: col("INTEGER", false),
            // NULL when only one end of the connection was loaded
            joined: col("INTEGER", true),
            // NULL when nothing joined, so there is no window
            lost: col("INTEGER", true),
            outside_window: col("INTEGER", true),
            negative_hops: col("INTEGER", true),   // NULL as joined
        },
    },
    coverage: {
        sql: `SELECT cid,
                     client_traces::INTEGER AS client_traces,
                     server_traces::INTEGER AS server_traces,
                     sender
              FROM coverage
              ORDER BY cid`,
        columns: {
            cid: col("VARCHAR", false),
            client_traces: col("INTEGER", false),
            server_traces: col("INTEGER", false),
            sender: col("VARCHAR", true, SENDERS),   // NULL when no object was logged
        },
    },
    distributionSummary: {
        sql: `SELECT measure,
                     unit,
                     scope,
                     track_namespace,
                     track_name,
                     n::INTEGER      AS n,
                     min::DOUBLE     AS min,
                     p1::DOUBLE      AS p1,
                     p5::DOUBLE      AS p5,
                     p50::DOUBLE     AS p50,
                     p95::DOUBLE     AS p95,
                     p99::DOUBLE     AS p99,
                     max::DOUBLE     AS max
              FROM distribution_summary
              ORDER BY measure, scope, track_namespace, track_name`,
        columns: {
            measure: col("VARCHAR", false, MEASURES),
            unit: col("VARCHAR", false, UNITS),
            scope: col("VARCHAR", false, SCOPES),
            track_namespace: col("VARCHAR", true),   // NULL on `all` rows
            track_name: col("VARCHAR", true),
            n: col("INTEGER", false),
            min: col("DOUBLE", false),
            p1: col("DOUBLE", false),
            p5: col("DOUBLE", false),
            p50: col("DOUBLE", false),
            p95: col("DOUBLE", false),
            p99: col("DOUBLE", false),
            max: col("DOUBLE", false),
        },
    },
    distributionBin: {
        sql: `SELECT measure,
                     scope,
                     track_namespace,
                     track_name,
                     bin::INTEGER    AS bin,
                     lo::DOUBLE      AS lo,
                     hi::DOUBLE      AS hi,
                     count::INTEGER  AS count
              FROM distribution_bin
              ORDER BY measure, scope, track_namespace, track_name, bin`,
        columns: {
            measure: col("VARCHAR", false, MEASURES),
            scope: col("VARCHAR", false, SCOPES),
            track_namespace: col("VARCHAR", true),
            track_name: col("VARCHAR", true),
            bin: col("INTEGER", false),
            lo: col("DOUBLE", false),
            hi: col("DOUBLE", false),
            count: col("INTEGER", false),
        },
    },
} as const satisfies Record<string, QuerySpec<Columns>>;

// --- distributions ----------------------------------------------------------

type SummaryRow = Row<(typeof QUERIES)["distributionSummary"]["columns"]>;
type BinRow = Row<(typeof QUERIES)["distributionBin"]["columns"]>;

/** One distribution out of the rows for all of them. A filter, not a join:
 *  both views are keyed by measure, scope and track. */
export function pickDistribution(
    summary: readonly SummaryRow[],
    bins: readonly BinRow[],
    measure: Measure,
    track?: Track,
): Distribution | null {
    const mine = (r: SummaryRow | BinRow) =>
        r.measure === measure
        && (track === undefined
            ? r.scope === "all"
            : r.scope === "track" && r.track_namespace === track.namespace && r.track_name === track.name);
    const s = summary.find(mine);
    if (s === undefined) return null;
    return {
        measure, unit: s.unit, n: s.n,
        min: s.min, p1: s.p1, p5: s.p5, p50: s.p50, p95: s.p95, p99: s.p99, max: s.max,
        bins: bins.filter(mine).map((b) => ({ lo: b.lo, hi: b.hi, count: b.count })),
    };
}

// --- SQL text ---------------------------------------------------------------

/** A string as a DuckDB literal. Names and cids come from untrusted manifests;
 *  doubling the quote is DuckDB's only escape inside '...'. */
export function sqlString(s: string): string {
    if (s.includes("\0")) throw new Error("NUL byte in a SQL string");
    return `'${s.replaceAll("'", "''")}'`;
}
