// The public header: everything a consumer's compiler sees of mlog-sql.
// package.json "exports" serves it under the "types" condition, and api.ts
// under "default" at runtime, so no internal type reaches a consumer.
// api.ts imports its public types from here. header-check.ts fails `tsc` when
// the values or the row types disagree with api.ts.
//
// The entry point and the queries come first. The types they name are in three
// folding regions below: what the caller supplies, rows, distributions.

/**
 * Load every trace, in order, on one connection, and return the queries.
 * One capture per engine: an engine that already holds traces is refused.
 * Throws CaptureError only. After a failure the engine holds a partial load, so
 * the caller discards it and starts a new one.
 */
export declare function openCapture(
    engine: Engine,
    traces: readonly TraceSource[],
    options?: CaptureOptions,
): Promise<Capture>;

/** Every method throws CaptureError only. */
export interface Capture {
    /** One track, or every track pooled when `track` is left out. null when
     *  there are no samples. */
    distribution(measure: Measure, track?: Track): Promise<Distribution | null>;
    legSummary(): Promise<LegSummaryRow[]>;
    trust(): Promise<TrustRow[]>;
    coverage(): Promise<CoverageRow[]>;
    jitterSummary(): Promise<JitterSummaryRow[]>;
    jitterSeries(): Promise<JitterSeriesRow[]>;
    relaySeries(): Promise<RelaySeriesRow[]>;
    objectBitrateSummary(): Promise<ObjectBitrateSummaryRow[]>;
    objectBitrateSeries(): Promise<ObjectBitrateSeriesRow[]>;
}


// #region what the caller supplies, and the error


/** One connection. The adapter turns duckdb-wasm's Arrow result into plain
 *  rows (`toArray().map(r => r.toJSON())`); mlog-sql checks them. */
export interface Conn {
    query(sql: string): Promise<unknown[]>;
}

/** The part of a duckdb-wasm database mlog-sql uses. The browser's AsyncDuckDB
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

export type CaptureFailure =
    /** A trace failed to load. */
    | { readonly kind: "load"; readonly trace: string; readonly message: string }
    /** A row did not match its columns: a bug in mlog-sql, or an engine version it was not tested with. */
    | {
        readonly kind: "row";
        readonly query: string;
        readonly row: number;
        readonly column: string;
        readonly message: string;
    }
    /** The engine failed outside a trace load: connect, schema, or a query. The engine's error is `cause`. */
    | { readonly kind: "engine"; readonly message: string }
    /** The engine already holds a capture. Use a new engine. */
    | { readonly kind: "engine-used" };

/** The only error mlog-sql throws. */
export declare class CaptureError extends Error {
    readonly failure: CaptureFailure;
    constructor(failure: CaptureFailure, options?: ErrorOptions);
}

// #endregion

// #region rows
// One row type per query. MEASURES.md says what each measure is and why.

/** `created`: an end sent it. `parsed`: an end received it. */
export type Direction = "created" | "parsed";
/** `all` sums every track of one end, direction and second. */
export type Scope = "all" | "track";
/** Legs of one object's path, in order. `leg_no` and `leg` always pair the same way. */
export type LegNo = 1 | 2 | 3;
export type Leg = "pub -> relay" | "relay dwell" | "relay -> sub";

export interface LegSummaryRow {
    readonly sub_cid: string;
    readonly leg_no: LegNo;
    readonly leg: Leg;
    readonly n: number;
    readonly mean_ms: number;
    readonly median_ms: number;
    readonly p95_ms: number;
}

export interface TrustRow {
    readonly cid: string;
    /** The end that created objects. NULL when no loaded end created any. */
    readonly sender_is: string | null;
    readonly sent: number;
    readonly received: number;
    /** NULL when only one end of the connection was loaded. */
    readonly joined: number | null;
    /** NULL when nothing joined, so no window says what counts as lost. */
    readonly lost: number | null;
    /** NULL as `lost`. */
    readonly outside_window: number | null;
    /** NULL as `joined`. */
    readonly negative_hops: number | null;
}

/** `client` or `server`: the end that sent objects. `both`: objects went each way. */
export type Sender = "client" | "server" | "both";

/** One connection: which of its ends were loaded. A measure needs certain ends
 *  (MEASURES.md), and has no rows without them. */
export interface CoverageRow {
    readonly cid: string;
    readonly client_traces: number;
    readonly server_traces: number;
    /** Read from either end. NULL when no object was logged. */
    readonly sender: Sender | null;
}

export interface JitterSummaryRow {
    readonly sub_cid: string;
    readonly leg_no: LegNo;
    readonly leg: Leg;
    readonly n: number;
    readonly mean_ms: number;
    readonly p95_ms: number;
    readonly p99_ms: number;
    readonly max_ms: number;
}

export interface JitterSeriesRow {
    readonly sub_cid: string;
    readonly leg_no: LegNo;
    readonly leg: Leg;
    readonly t_s: number;
    readonly n: number;
    readonly mean_ms: number;
    readonly max_ms: number;
}

/**
 * - `relay dwell`: mean time the relay held an object, every subscriber and track pooled.
 * - `relay egress jitter`: mean |D| of relay dwell, pooled the same way: how
 *   much the relay's own delay changes from one object to the next.
 * - `subscriber jitter`: mean |D| on the relay -> subscriber leg, one series
 *   per subscriber. Needs the subscribers' logs.
 */
export type RelaySeries = "relay dwell" | "relay egress jitter" | "subscriber jitter";

/** One dot: one series in one second. Held objects are left out. */
export interface RelaySeriesRow {
    readonly series: RelaySeries;
    /** The subscriber, for `subscriber jitter`. NULL on the two pooled series. */
    readonly sub_cid: string | null;
    readonly t_s: number;
    /** Samples in this second. */
    readonly n: number;
    readonly mean_ms: number;
}

export interface ObjectBitrateSummaryRow {
    readonly cid: string;
    /** As the log wrote it, unchecked. */
    readonly vantage_point: string;
    readonly direction: Direction;
    readonly scope: Scope;
    readonly track_namespace: string | null;
    readonly track_name: string | null;
    readonly bytes: number;
    readonly seconds: number;
    readonly span_s: number;
    /** NULL when the end's log is two seconds or shorter. */
    readonly mean_kbit_s: number | null;
    /** This and the rest: also NULL when no second of the interior has data. */
    readonly p5_kbit_s: number | null;
    readonly median_kbit_s: number | null;
    readonly p95_kbit_s: number | null;
    readonly max_kbit_s: number | null;
}

export interface ObjectBitrateSeriesRow {
    readonly cid: string;
    /** As the log wrote it, unchecked. */
    readonly vantage_point: string;
    readonly direction: Direction;
    readonly scope: Scope;
    /** NULL on `all` rows and unresolved tracks. */
    readonly track_namespace: string | null;
    readonly track_name: string | null;
    readonly t_s: number;
    readonly objects: number;
    readonly bytes: number;
    readonly kbit_s: number;
}

// #endregion

// #region distributions
// One measure's samples, pooled over every subscriber, so the size stays fixed
// however many subscribers the capture has. Not a view row: one call gives the
// quantiles and the bins together.

/**
 * What one sample is:
 * - `end to end`: one object reaching one subscriber, from the publisher
 *   creating it to the subscriber parsing it. Held objects are left out.
 * - `relay dwell`: one object sent on to one subscriber, from the relay parsing
 *   it to the relay creating it again. Held objects are left out.
 * - `interarrival`: the gap between one object arriving at a subscriber and the
 *   one before it on the same track. It includes the publisher's pacing.
 * - `bitrate`: one second of payload that one subscriber received. The first
 *   and last second of each log are partial and left out.
 */
export type Measure = "end to end" | "relay dwell" | "interarrival" | "bitrate";

/** `ms` for every measure but `bitrate`, which is `kbit/s`. */
export type Unit = "ms" | "kbit/s";

export interface Track {
    readonly namespace: string;
    readonly name: string;
}

/** Samples from `lo` up to but not including `hi`, except the last bin, which includes `hi`. */
export interface Bin {
    readonly lo: number;
    readonly hi: number;
    readonly count: number;
}

export interface Distribution {
    readonly measure: Measure;
    readonly unit: Unit;
    /** Samples. The bin counts add up to it. */
    readonly n: number;
    readonly min: number;
    readonly p1: number;
    readonly p5: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
    /** In order and with no gaps, from `min` to `max`. mlog-sql picks the edges. */
    readonly bins: readonly Bin[];
}

// #endregion
