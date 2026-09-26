// The parts of api.ts that need their own tests: cutting a byte stream into
// whole-record chunks, and checking query rows against a column spec. Private
// to mlog-sql -- html4 imports api.ts only, which re-exports what it needs.

// --- errors -----------------------------------------------------------------

export type CaptureFailure =
    | { readonly kind: "load"; readonly trace: string; readonly message: string }
    | {
        readonly kind: "row";
        readonly query: string;
        readonly row: number;
        readonly column: string;
        readonly message: string;
    };

export class CaptureError extends Error {
    readonly failure: CaptureFailure;
    constructor(failure: CaptureFailure) {
        super(failure.kind === "load"
            ? `load failed for "${failure.trace}": ${failure.message}`
            : `${failure.query} row ${failure.row}, column ${failure.column}: ${failure.message}`);
        this.name = "CaptureError";
        this.failure = failure;
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
}

export type Columns = Readonly<Record<string, Column>>;

type Value<C extends Column> =
    | (C["type"] extends "VARCHAR" ? string : number)
    | (C["nullable"] extends true ? null : never);

export type Row<C extends Columns> = { readonly [K in keyof C]: Value<C[K]> };

/** One query and the exact columns it must return, in order. The row type, the
 *  row check, and the DESCRIBE contract test all come from this one object. */
export interface QuerySpec<C extends Columns> {
    readonly sql: string;
    readonly columns: C;
}

export const col = <T extends SqlType, N extends boolean>(type: T, nullable: N) =>
    ({ type, nullable });

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
            leg_no: col("INTEGER", false),
            leg: col("VARCHAR", false),
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
            leg_no: col("INTEGER", false),
            leg: col("VARCHAR", false),
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
            leg_no: col("INTEGER", false),
            leg: col("VARCHAR", false),
            t_s: col("INTEGER", false),
            n: col("INTEGER", false),
            mean_ms: col("DOUBLE", false),
            max_ms: col("DOUBLE", false),
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
            joined: col("INTEGER", false),
            lost: col("INTEGER", false),
            outside_window: col("INTEGER", false),
            negative_hops: col("INTEGER", false),
        },
    },
} as const satisfies Record<string, QuerySpec<Columns>>;

// --- SQL text ---------------------------------------------------------------

/** A string as a DuckDB literal. Names and cids come from untrusted manifests;
 *  doubling the quote is DuckDB's only escape inside '...'. */
export function sqlString(s: string): string {
    if (s.includes("\0")) throw new Error("NUL byte in a SQL string");
    return `'${s.replaceAll("'", "''")}'`;
}
