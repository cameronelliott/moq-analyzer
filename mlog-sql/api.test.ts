// Proves api.ts: the contract html4 relies on, the stream-to-chunk loader, and
// the row checks.
//   bun test api
//
// The contract test is the one that guards the boundary: each query's DESCRIBE
// must match the columns api.ts promises, so a view that drifts fails here, in
// mlog-sql, before html4 renders a stuck "—".
//
// The engine adapter below is test-only and deliberately small; html4 keeps its
// own. Both are the only code that touches duckdb-wasm's Arrow results.
//
// The real-6pop test reads raw mlogs from a1/data and skips when they are
// absent. Like wasm.test.ts, the first run fetches ICU and JSON extensions.

import { test, expect, describe } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    createDuckDB, NODE_RUNTIME, ConsoleLogger, LogLevel,
} from "@duckdb/duckdb-wasm/blocking";
import {
    openCapture, CaptureError,
    type Distribution, type Measure, type MeasuredAt,
    type Engine, type TraceSource, type CoverageRow, type LegSummaryRow, type JitterSummaryRow,
    type RelaySeriesRow,
    type JitterSeriesRow, type ObjectBitrateSeriesRow, type ObjectBitrateSummaryRow,
} from "./api";
import { QUERIES, col, recordChunks, validateRows } from "./api-internal";

const REPO = import.meta.dir;
const DIST = join(REPO, "node_modules", "@duckdb", "duckdb-wasm", "dist");
const REAL_6POP = join(REPO, "..", "..", "a1", "data", "real-6pop");

// --- engine -----------------------------------------------------------------

async function nodeEngine(): Promise<{ engine: Engine; reset(): void }> {
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
        engine: {
            registerFileBuffer: async (name, bytes) => { db.registerFileBuffer(name, bytes); },
            dropFile: async (name) => { db.dropFile(name); },
            connect: async () => {
                const c = db.connect();
                return { query: async (sql) => c.query(sql).toArray().map((r) => r.toJSON()) };
            },
        },
        reset: () => db.reset(),
    };
}

/** Plain bytes as a stream arriving in pieces of `piece` bytes. */
function streamOf(text: string, piece = 64 * 1024): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    let at = 0;
    return new ReadableStream({
        pull(ctl) {
            if (at >= bytes.length) return ctl.close();
            ctl.enqueue(bytes.slice(at, at + piece));
            at += piece;
        },
    });
}

// --- fixture: publisher -> relay -> one subscriber --------------------------
//
// Four traces, two connections. Objects leave the publisher at 10/20/30 ms,
// reach the relay 50 ms later, leave it 1 ms after that, and reach the
// subscriber 39 ms after that. So leg 1 = 50, leg 2 = 1, leg 3 = 39 ms, exactly.

const REFERENCE_TIME = 1788560083342.7483;

const header = (vantage: "client" | "server") => ({
    qlog_version: "0.3", qlog_format: "JSON-SEQ", title: "api-test",
    trace: {
        vantage_point: { type: vantage },
        common_fields: { reference_time: REFERENCE_TIME, time_format: "relative" },
        event_schemas: ["urn:ietf:params:qlog:events:moqt"],
    },
});

type Dir = "created" | "parsed";

const ctrl = (time: number, dir: Dir, data: Record<string, unknown>) => ({
    time, name: `moqt:control_message_${dir}`,
    data: { event_type: `control_message_${dir}`, stream_id: 0, ...data },
});

/** subscribe then subscribe_ok, so the trace resolves its track alias. */
const subscribe = (subDir: Dir, okDir: Dir, alias: number) => [
    ctrl(1, subDir, {
        message_type: "subscribe", subscribe_id: 1,
        track_namespace: "/bbb", track_name: "1.m4s", parameters: [],
    }),
    ctrl(2, okDir, {
        message_type: "subscribe_ok", subscribe_id: 1, track_alias: alias,
        parameters: [], track_extensions: [],
    }),
];

const objects = (dir: Dir, stream: number, alias: number, times: number[]) => [
    {
        time: times[0]! - 1, name: `moqt:subgroup_header_${dir}`,
        data: {
            event_type: `subgroup_header_${dir}`, stream_id: stream,
            header_type: "SubgroupIdExt", track_alias: alias,
            group_id: 7, publisher_priority: 0, subgroup_id: 0,
        },
    },
    ...times.map((time, id) => ({
        time, name: `moqt:subgroup_object_${dir}`,
        data: {
            event_type: `subgroup_object_${dir}`, stream_id: stream,
            group_id: 7, subgroup_id: 0, object_id: id,
            extension_headers: [], object_payload_length: 1271,
        },
    })),
];

const mlog = (head: unknown, events: unknown[]) =>
    [head, ...events].map((o) => "\x1e" + JSON.stringify(o)).join("\n") + "\n";

const FIXTURE: { name: string; cid: string; text: string }[] = [
    { name: "pub_client.mlog", cid: "pub", text: mlog(header("client"), [
        ...subscribe("parsed", "created", 5), ...objects("created", 2, 5, [10, 20, 30])]) },
    { name: "pub_server.mlog", cid: "pub", text: mlog(header("server"), [
        ...subscribe("created", "parsed", 4), ...objects("parsed", 2, 4, [60, 70, 80])]) },
    { name: "sub1_server.mlog", cid: "sub1", text: mlog(header("server"), [
        ...subscribe("parsed", "created", 9), ...objects("created", 3, 9, [61, 71, 81])]) },
    { name: "sub1_client.mlog", cid: "sub1", text: mlog(header("client"), [
        ...subscribe("created", "parsed", 3), ...objects("parsed", 3, 3, [100, 110, 120])]) },
];

const fixtureSources = (piece?: number): TraceSource[] =>
    FIXTURE.map((f) => ({ name: f.name, cid: f.cid, stream: streamOf(f.text, piece) }));

const EXPECTED_LEGS: LegSummaryRow[] = [
    { sub_cid: "sub1", leg_no: 1, leg: "pub -> relay", n: 3, mean_ms: 50, median_ms: 50, p95_ms: 50 },
    { sub_cid: "sub1", leg_no: 2, leg: "relay dwell",  n: 3, mean_ms: 1,  median_ms: 1,  p95_ms: 1 },
    { sub_cid: "sub1", leg_no: 3, leg: "relay -> sub", n: 3, mean_ms: 39, median_ms: 39, p95_ms: 39 },
];

const EXPECTED_TRUST = [
    { cid: "pub",  sender_is: "client", sent: 3, received: 3, joined: 3, lost: 0, outside_window: 0, negative_hops: 0 },
    { cid: "sub1", sender_is: "server", sent: 3, received: 3, joined: 3, lost: 0, outside_window: 0, negative_hops: 0 },
];

const EXPECTED_COVERAGE: CoverageRow[] = [
    { cid: "pub",  client_traces: 1, server_traces: 1, sender: "client" },
    { cid: "sub1", client_traces: 1, server_traces: 1, sender: "server" },
];

// The fixture as a relay operator has it: the relay's side of each connection.
const relaySources = (): TraceSource[] =>
    fixtureSources().filter((s) => s.name.endsWith("_server.mlog"));

// Every leg's transit is constant, so D is zero throughout: this pins the
// plumbing, and direction.test.ts pins the arithmetic. Three objects give two
// samples each, all in the capture's first second.
const EXPECTED_JITTER_SUMMARY = ([1, 2, 3] as const).map((leg_no): JitterSummaryRow => ({
    sub_cid: "sub1", leg_no, leg: EXPECTED_LEGS[leg_no - 1]!.leg,
    n: 2, mean_ms: 0, p95_ms: 0, p99_ms: 0, max_ms: 0,
}));

const EXPECTED_JITTER_SERIES = ([1, 2, 3] as const).map((leg_no): JitterSeriesRow => ({
    sub_cid: "sub1", leg_no, leg: EXPECTED_LEGS[leg_no - 1]!.leg,
    t_s: 0, n: 2, mean_ms: 0, max_ms: 0,
}));

// Dwell is 1 ms on all three objects and every transit is constant, so |D| is
// 0 on both jitter series. All in the capture's first second.
const EXPECTED_RELAY_SERIES: RelaySeriesRow[] = [
    { series: "relay dwell",         sub_cid: null,   t_s: 0, n: 3, mean_ms: 1 },
    { series: "relay egress jitter", sub_cid: null,   t_s: 0, n: 2, mean_ms: 0 },
    { series: "subscriber jitter",   sub_cid: "sub1", t_s: 0, n: 2, mean_ms: 0 },
];

// Each of the four traces has three 1271-byte objects inside one second: one
// `track` row and one `all` row per end, and no interior second to rate.
const BITRATE_ENDS = [
    { cid: "pub",  vantage_point: "client", direction: "created" },
    { cid: "pub",  vantage_point: "server", direction: "parsed" },
    { cid: "sub1", vantage_point: "client", direction: "parsed" },
    { cid: "sub1", vantage_point: "server", direction: "created" },
] as const;
const SCOPES = [
    { scope: "all",   track_namespace: null,   track_name: null },
    { scope: "track", track_namespace: "/bbb", track_name: "1.m4s" },
] as const;

const EXPECTED_BITRATE_SERIES = BITRATE_ENDS.flatMap((e) => SCOPES.map((s): ObjectBitrateSeriesRow => ({
    ...e, ...s, t_s: 0, objects: 3, bytes: 3 * 1271, kbit_s: 3 * 1271 * 8 / 1000,
})));

const EXPECTED_BITRATE_SUMMARY = BITRATE_ENDS.flatMap((e) => SCOPES.map((s): ObjectBitrateSummaryRow => ({
    ...e, ...s, bytes: 3 * 1271, seconds: 0, span_s: 0,
    mean_kbit_s: null, p5_kbit_s: null, median_kbit_s: null, p95_kbit_s: null, max_kbit_s: null,
})));

// Every sample of a measure is the same value, so every quantile is that value
// and there is one bin. Bitrate has no interior second, so no samples.
const TRACK = { namespace: "/bbb", name: "1.m4s" };
const flat = (
    measure: Measure, n: number, v: number,
    measured_at: MeasuredAt = measure === "relay dwell" ? "relay" : "subscriber",
): Distribution => ({
    measure, unit: "ms", measured_at, n,
    min: v, p1: v, p5: v, p50: v, p95: v, p99: v, max: v,
    bins: [{ lo: v, hi: v, count: n }],
});
const EXPECTED_DISTRIBUTIONS: [Measure, Distribution | null][] = [
    ["end to end", flat("end to end", 3, 90)],
    ["relay dwell", flat("relay dwell", 3, 1)],
    ["interarrival", flat("interarrival", 2, 10)],
    ["bitrate", null],
];

const DUPLICATE_AUDIT =readFileSync(join(REPO, "test-duplicated-mlog.sql"), "utf8");

// --- the contract -----------------------------------------------------------

const DESCRIBE_SPEC = {
    sql: "",
    columns: {
        column_name: col("VARCHAR", false),
        column_type: col("VARCHAR", false),
        null: col("VARCHAR", true),
        key: col("VARCHAR", true),
        default: col("VARCHAR", true),
        extra: col("VARCHAR", true),
    },
};

describe("contract", () => {
    // package.json "exports" makes api.ts the whole package. Types vanish at
    // runtime, so this pins only the values; a new one must be added here on purpose.
    test("api.ts exports exactly these values", async () => {
        expect(Object.keys(await import("./api")).sort()).toEqual(["CaptureError", "RECOVERED_DWELL", "openCapture"]);
    });

    for (const [name, spec] of Object.entries(QUERIES)) {
        test(`${name}: DESCRIBE matches the promised columns, in order`, async () => {
            const { engine, reset } = await nodeEngine();
            try {
                const conn = await engine.connect();
                await conn.query(readFileSync(join(REPO, "schema.sql"), "utf8"));
                const described = validateRows("DESCRIBE", DESCRIBE_SPEC,
                    await conn.query(`DESCRIBE ${spec.sql}`));
                expect(described.map((r) => [r.column_name, r.column_type]))
                    .toEqual(Object.entries(spec.columns).map(([n, c]) => [n, c.type]));
            } finally {
                reset();
            }
        });
    }
});

// --- loading ----------------------------------------------------------------

describe("openCapture", () => {
    test("the fixture gives the exact legs and trust it was built for", async () => {
        const { engine, reset } = await nodeEngine();
        try {
            const cap = await openCapture(engine, fixtureSources());
            expect(await cap.legSummary()).toEqual(EXPECTED_LEGS);
            expect(await cap.trust()).toEqual(EXPECTED_TRUST);
            expect(await cap.coverage()).toEqual(EXPECTED_COVERAGE);
            expect(await cap.jitterSummary()).toEqual(EXPECTED_JITTER_SUMMARY);
            expect(await cap.jitterSeries()).toEqual(EXPECTED_JITTER_SERIES);
            expect(await cap.relaySeries()).toEqual(EXPECTED_RELAY_SERIES);
            expect(await cap.objectBitrateSeries()).toEqual(EXPECTED_BITRATE_SERIES);
            expect(await cap.objectBitrateSummary()).toEqual(EXPECTED_BITRATE_SUMMARY);
            // The fixture has one track, so it and every track pooled agree.
            for (const [measure, expected] of EXPECTED_DISTRIBUTIONS) {
                expect(await cap.distribution(measure)).toEqual(expected);
                expect(await cap.distribution(measure, TRACK)).toEqual(expected);
            }
            expect(await cap.distribution("end to end", { ...TRACK, name: "none" })).toBeNull();
        } finally {
            reset();
        }
    });

    test("the relay's traces alone give dwell, and no claim about the far ends", async () => {
        const { engine, reset } = await nodeEngine();
        try {
            const cap = await openCapture(engine, relaySources());
            expect(await cap.coverage()).toEqual(EXPECTED_COVERAGE.map((r) =>
                ({ ...r, client_traces: 0 })));
            expect(await cap.legSummary()).toEqual(EXPECTED_LEGS.filter((r) => r.leg_no === 2));
            expect(await cap.jitterSummary()).toEqual(EXPECTED_JITTER_SUMMARY.filter((r) => r.leg_no === 2));
            expect(await cap.relaySeries()).toEqual(
                EXPECTED_RELAY_SERIES.filter((r) => r.series !== "subscriber jitter"));
            // Each connection has one end, so nothing joins and nothing is
            // claimed lost. sender_is is the end that created: none on "pub".
            expect(await cap.trust()).toEqual([
                { cid: "pub",  sender_is: null,     sent: 0, received: 3,
                  joined: null, lost: null, outside_window: null, negative_hops: null },
                { cid: "sub1", sender_is: "server", sent: 3, received: 0,
                  joined: null, lost: null, outside_window: null, negative_hops: null },
            ]);
            expect(await cap.distribution("relay dwell")).toEqual(flat("relay dwell", 3, 1));
            expect(await cap.distribution("end to end")).toBeNull();
            // No subscriber's log, so interarrival is the gap at the relay, on
            // the publisher's connection, and says so. 60, 70, 80 ms: two gaps.
            expect(await cap.distribution("interarrival")).toEqual(flat("interarrival", 2, 10, "relay"));
            expect(await cap.distribution("interarrival", TRACK)).toEqual(flat("interarrival", 2, 10, "relay"));
            expect(await cap.distribution("bitrate")).toBeNull();   // no interior second
        } finally {
            reset();
        }
    });

    test("tiny chunks and ragged pieces land the same capture, with no duplicates", async () => {
        // chunkBytes 1 puts every record in its own chunk; 7-byte pieces cut
        // records at every possible offset on the way in.
        const { engine, reset } = await nodeEngine();
        try {
            const cap = await openCapture(engine, fixtureSources(7), { chunkBytes: 1 });
            expect(await cap.legSummary()).toEqual(EXPECTED_LEGS);
            expect(await cap.trust()).toEqual(EXPECTED_TRUST);
            const audit = await (await engine.connect()).query(DUPLICATE_AUDIT);
            expect(audit).toEqual([]);
        } finally {
            reset();
        }
    });

    test("a quote in a name or cid is data, not SQL", async () => {
        const { engine, reset } = await nodeEngine();
        try {
            const text = FIXTURE[0]!.text;
            await openCapture(engine, [{ name: "it's.mlog", cid: "o'brien", stream: streamOf(text) }]);
            const rows = await (await engine.connect())
                .query("SELECT filename, cid FROM trace");
            expect(rows).toEqual([{ filename: "it's.mlog", cid: "o'brien" }]);
        } finally {
            reset();
        }
    });

    test("a malformed record fails the load and names the trace", async () => {
        const { engine, reset } = await nodeEngine();
        try {
            const bad = FIXTURE[0]!.text + '{"time": 40, "name": \n';
            const err = await openCapture(engine,
                [{ name: "bad.mlog", cid: "c", stream: streamOf(bad) }], { chunkBytes: 1 })
                .catch((e: unknown) => e);
            expect(err).toBeInstanceOf(CaptureError);
            if (!(err instanceof CaptureError)) return;
            expect(err.failure.kind).toBe("load");
            expect(err.message).toContain("bad.mlog");
            expect(err.message).toContain("Malformed JSON");
        } finally {
            reset();
        }
    });

    test("an empty stream is an error, not an empty trace", async () => {
        const { engine, reset } = await nodeEngine();
        try {
            await expect(openCapture(engine, [{ name: "empty.mlog", cid: "c", stream: streamOf("") }]))
                .rejects.toThrow(/no records/);
        } finally {
            reset();
        }
    });

    test("one capture per engine", async () => {
        const { engine, reset } = await nodeEngine();
        try {
            await openCapture(engine, fixtureSources());
            const err = await openCapture(engine, fixtureSources()).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(CaptureError);
            if (!(err instanceof CaptureError)) return;
            expect(err.failure.kind).toBe("engine-used");
            expect(err.message).toMatch(/already holds/);
        } finally {
            reset();
        }
    });

    // A fake engine: it fails on the SQL that starts with `failOn`, and answers
    // everything else with the rows openCapture expects of an empty database.
    const fakeEngine = (failOn: string): Engine => ({
        registerFileBuffer: async () => undefined,
        dropFile: async () => undefined,
        connect: async () => {
            if (failOn === "connect") throw new TypeError("no worker");
            return {
                query: async (sql) => {
                    if (sql.trimStart().startsWith(failOn)) throw new Error("extension fetch failed");
                    return sql.startsWith("SELECT count(*)") ? [{ n: 0 }] : [];
                },
            };
        },
    });

    const engineFailure = async (p: Promise<unknown>) => {
        const err = await p.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CaptureError);
        if (!(err instanceof CaptureError)) return;
        expect(err.failure.kind).toBe("engine");
        expect(err.cause).toBeInstanceOf(Error);
    };

    test("an engine that cannot connect is a CaptureError", () =>
        engineFailure(openCapture(fakeEngine("connect"), [])));

    test("a schema that fails to load is a CaptureError", () =>
        engineFailure(openCapture(fakeEngine("--"), [])));

    test("a query that fails in a Capture method is a CaptureError", async () => {
        const cap = await openCapture(fakeEngine("SELECT sub_cid"), []);
        await engineFailure(cap.legSummary());
    });
});

// --- bins -------------------------------------------------------------------

describe("distribution_bin", () => {
    // 0..100 and one outlier at 1000. p99 is 99.99, so the width is 5 (99.99 /
    // 20 rounded up to 1, 2 or 5 times a power of ten): 20 bins of five, and
    // one last bin from 100 to max holding 100 and the outlier.
    test("round widths up to p99, then one bin to max", async () => {
        const { engine, reset } = await nodeEngine();
        try {
            const conn = await engine.connect();
            await conn.query(readFileSync(join(REPO, "schema.sql"), "utf8"));
            await conn.query(`CREATE OR REPLACE VIEW distribution_sample AS
                SELECT 'relay dwell' AS measure, 'ms' AS unit, 'relay' AS measured_at, 'all' AS scope,
                       NULL::VARCHAR AS track_namespace, NULL::VARCHAR AS track_name,
                       v::DOUBLE AS value
                FROM (SELECT unnest(range(101)) AS v UNION ALL SELECT 1000)`);
            const bins = validateRows("distributionBin", QUERIES.distributionBin,
                await conn.query(QUERIES.distributionBin.sql));
            expect(bins.map((b) => [b.lo, b.hi, b.count])).toEqual([
                ...Array.from({ length: 20 }, (_, i) => [i * 5, i * 5 + 5, 5]),
                [100, 1000, 2],
            ]);
        } finally {
            reset();
        }
    });
});

// --- chunking ---------------------------------------------------------------

describe("recordChunks", () => {
    const text = ["a", "bb", "", "cccccccc", "d", "eeeeeeeeeeeeeeeeeeee", "ff"].join("\n") + "\n";

    test("every chunk ends a record, and the chunks rebuild the input", async () => {
        for (let piece = 1; piece <= 12; piece++) {
            for (let target = 1; target <= 40; target++) {
                const chunks: string[] = [];
                for await (const c of recordChunks(streamOf(text, piece), target)) {
                    chunks.push(new TextDecoder().decode(c));
                }
                expect(chunks.join("")).toBe(text);
                for (const c of chunks) expect(c.endsWith("\n")).toBe(true);
            }
        }
    });

    test("a final record with no LF is kept", async () => {
        const chunks: string[] = [];
        for await (const c of recordChunks(streamOf("a\nb", 1), 1)) {
            chunks.push(new TextDecoder().decode(c));
        }
        expect(chunks).toEqual(["a\n", "b"]);
    });
});

// --- rows -------------------------------------------------------------------

describe("validateRows", () => {
    const spec = { sql: "", columns: { s: col("VARCHAR", false), n: col("INTEGER", true) } };
    const fails = (rows: unknown[], pattern: RegExp) =>
        expect(() => validateRows("q", spec, rows)).toThrow(pattern);

    test("a good row passes through", () => {
        expect(validateRows("q", spec, [{ s: "x", n: 1 }, { s: "y", n: null }]))
            .toEqual([{ s: "x", n: 1 }, { s: "y", n: null }]);
    });
    test("BIGINT is refused, with the fix", () => fails([{ s: "x", n: 1n }], /cast it to INTEGER/));
    test("NULL in a NOT NULL column", () => fails([{ s: null, n: 1 }], /NOT NULL/));
    test("wrong type", () => fails([{ s: 3, n: 1 }], /expected VARCHAR/));
    test("fraction in an INTEGER", () => fails([{ s: "x", n: 1.5 }], /expected INTEGER/));
    test("missing column", () => fails([{ s: "x" }], /missing/));
    test("extra column", () => fails([{ s: "x", n: 1, z: 0 }], /not in the spec/));

    const fixed = { sql: "", columns: { s: col("VARCHAR", false, ["a", "b"]), n: col("INTEGER", true, [1, 2]) } };
    test("a value in the set passes", () => {
        expect(validateRows("q", fixed, [{ s: "b", n: null }])).toEqual([{ s: "b", n: null }]);
    });
    test("a value outside the set", () => {
        expect(() => validateRows("q", fixed, [{ s: "c", n: 1 }])).toThrow(/not one of/);
        expect(() => validateRows("q", fixed, [{ s: "a", n: 3 }])).toThrow(/not one of/);
    });
});

// --- real capture -----------------------------------------------------------

describe.skipIf(!existsSync(REAL_6POP))("real-6pop", () => {
    const PUBLISHER = "c45a526b08ad99ea276b9813b0f66ac5";

    const sources = (): TraceSource[] =>
        readdirSync(REAL_6POP)
            .filter((f) => f.endsWith(".mlog.gz"))
            .sort()
            .map((f) => ({
                name: f.replace(/\.gz$/, ""),
                cid: f.split("_")[0]!,
                stream: Bun.file(join(REAL_6POP, f)).stream()
                    .pipeThrough(new DecompressionStream("gzip")),
            }));

    test("streams all ten mlogs and gives sane legs and trust", async () => {
        const { engine, reset } = await nodeEngine();
        try {
            const t0 = performance.now();
            const cap = await openCapture(engine, sources());
            const loadMs = performance.now() - t0;

            const legs = await cap.legSummary();
            const subs = [...new Set(legs.map((r) => r.sub_cid))];
            expect(subs).toHaveLength(4);
            expect(subs).not.toContain(PUBLISHER);
            expect(legs).toHaveLength(12);

            // Leg 1 is one physical hop, measured once per subscriber: the
            // medians must agree (the `leg` view says within 0.02 ms).
            const leg1 = legs.filter((r) => r.leg_no === 1).map((r) => r.median_ms);
            expect(Math.max(...leg1) - Math.min(...leg1)).toBeLessThan(0.05);
            for (const m of leg1) expect(m).toBeGreaterThan(70);
            for (const m of leg1) expect(m).toBeLessThan(80);

            // Roles come from the data: the publisher's connection is sent from
            // its client end, every subscriber's from the relay's server end.
            const coverage = await cap.coverage();
            expect(coverage).toHaveLength(5);
            for (const r of coverage) {
                expect([r.client_traces, r.server_traces]).toEqual([1, 1]);
                expect(r.sender).toBe(r.cid === PUBLISHER ? "client" : "server");
            }

            const trust = await cap.trust();
            expect(trust).toHaveLength(5);
            for (const r of trust) {
                expect(r.sender_is).toBe(r.cid === PUBLISHER ? "client" : "server");
                expect(r.negative_hops).toBe(0);
            }

            // Jitter is RFC 3550 |D| in ms. Means run 0.07-0.13 ms here; a
            // unit slip lands 1000x off either way. Leg 1 is again one shared
            // hop, so its means must agree across subscribers.
            const jit = await cap.jitterSummary();
            expect(jit).toHaveLength(12);
            for (const r of jit) {
                expect(r.mean_ms).toBeGreaterThan(0.01);
                expect(r.mean_ms).toBeLessThan(1);
                expect(r.p95_ms).toBeLessThanOrEqual(r.p99_ms);
                expect(r.p99_ms).toBeLessThanOrEqual(r.max_ms);
            }
            const jit1 = jit.filter((r) => r.leg_no === 1).map((r) => r.mean_ms);
            expect(Math.max(...jit1) - Math.min(...jit1)).toBeLessThan(0.01);

            // One row per subscriber, leg and second: the longest subscriber
            // ran 959 s, so the axis starts at 0 and stays inside that.
            const series = await cap.jitterSeries();
            expect(Math.min(...series.map((r) => r.t_s))).toBe(0);
            expect(Math.max(...series.map((r) => r.t_s))).toBeLessThan(1000);
            expect(series.reduce((n, r) => n + r.n, 0))
                .toBe(jit.reduce((n, r) => n + r.n, 0));

            // relay_series holds the same samples as the leg and jitter frames:
            // dwell and its |D| pooled, subscriber |D| once per subscriber.
            const relay = await cap.relaySeries();
            const samples = (s: string) =>
                relay.filter((r) => r.series === s).reduce((n, r) => n + r.n, 0);
            const legN = (rows: readonly { leg_no: number; n: number }[], leg: number) =>
                rows.filter((r) => r.leg_no === leg).reduce((n, r) => n + r.n, 0);
            expect(samples("relay dwell")).toBe(legN(legs, 2));
            expect(samples("relay egress jitter")).toBe(legN(jit, 2));
            expect(samples("subscriber jitter")).toBe(legN(jit, 3));
            expect(new Set(relay.filter((r) => r.series === "subscriber jitter")
                .map((r) => r.sub_cid))).toEqual(new Set(subs));
            for (const r of relay.filter((r) => r.series === "relay dwell")) {
                expect(r.mean_ms).toBeLessThan(50);   // held objects are left out
            }

            // Object bitrate. Every end carries the same ~334 kbit/s stream, so
            // a unit slip is far outside 250-450. Track means add up to the
            // `all` mean, and `all` rows hold exactly the track rows' bytes.
            const rates = await cap.objectBitrateSummary();
            const ends = new Map<string, { all: number | null; tracks: number }>();
            for (const r of rates) {
                const key = `${r.cid} ${r.vantage_point} ${r.direction}`;
                const e = ends.get(key) ?? { all: null, tracks: 0 };
                // every end here runs minutes, so no mean may be NULL -- not
                // even the init segment's, which is 0 over the interior
                expect(r.mean_kbit_s).not.toBeNull();
                if (r.scope === "all") e.all = r.mean_kbit_s;
                else e.tracks += r.mean_kbit_s ?? 0;
                ends.set(key, e);
            }
            expect(ends.size).toBe(10);
            for (const e of ends.values()) {
                expect(e.all).toBeGreaterThan(250);
                expect(e.all).toBeLessThan(450);
                expect(e.tracks).toBeCloseTo(e.all ?? 0, 6);
            }
            const bitrate = await cap.objectBitrateSeries();
            const bytesOf = (scope: string) =>
                bitrate.filter((r) => r.scope === scope).reduce((n, r) => n + r.bytes, 0);
            expect(bytesOf("all")).toBe(bytesOf("track"));

            // The relay sends each subscriber at least what that subscriber
            // received: the rest went out after the subscriber's log stopped.
            for (const sub of subs) {
                const sent = rates.find((r) => r.cid === sub && r.scope === "all" && r.direction === "created");
                const got = rates.find((r) => r.cid === sub && r.scope === "all" && r.direction === "parsed");
                expect(sent?.vantage_point).toBe("server");
                expect(got?.vantage_point).toBe("client");
                expect(sent!.bytes).toBeGreaterThanOrEqual(got!.bytes);
            }

            // Distributions, every track pooled. Bins run from min to max with
            // no gaps and hold every sample. End to end's median sits near the
            // 131.76 ms the `leg` view records; dwell's is under a millisecond.
            const t1 = performance.now();
            const dist = new Map<Measure, Distribution>();
            for (const m of ["end to end", "relay dwell", "interarrival", "bitrate"] as const) {
                const d = await cap.distribution(m);
                expect(d).not.toBeNull();
                if (d === null) return;
                dist.set(m, d);
                const q = [d.min, d.p1, d.p5, d.p50, d.p95, d.p99, d.max];
                expect(q).toEqual([...q].sort((a, b) => a - b));
                expect(d.bins.reduce((n, b) => n + b.count, 0)).toBe(d.n);
                expect(d.bins[0]?.lo).toBe(d.min);
                expect(d.bins.at(-1)?.hi).toBe(d.max);
                for (let i = 1; i < d.bins.length; i++) expect(d.bins[i]!.lo).toBe(d.bins[i - 1]!.hi);
                expect(d.bins.length).toBeLessThanOrEqual(22);
            }
            const distMs = performance.now() - t1;
            expect(dist.get("end to end")!.p50).toBeGreaterThan(120);
            expect(dist.get("end to end")!.p50).toBeLessThan(145);
            expect(dist.get("relay dwell")!.p50).toBeLessThan(1);
            expect(dist.get("bitrate")!.p50).toBeGreaterThan(250);
            expect(dist.get("bitrate")!.p50).toBeLessThan(450);
            // Subscribers' logs are loaded, so nothing falls back to the relay.
            expect((["end to end", "relay dwell", "interarrival", "bitrate"] as const).map((m) =>
                dist.get(m)?.measured_at)).toEqual(["subscriber", "relay", "subscriber", "subscriber"]);

            const audit = await (await engine.connect()).query(DUPLICATE_AUDIT);
            expect(audit).toEqual([]);

            console.log(`real-6pop: distributions in ${(distMs / 1000).toFixed(1)} s;`
                + ` bins ${[...dist.values()].map((d) => d.bins.length).join(", ")}`);
            console.log(`real-6pop: loaded in ${(loadMs / 1000).toFixed(1)} s;`
                + ` leg 1 medians ${leg1.map((m) => m.toFixed(2)).join(", ")} ms`);
        } finally {
            reset();
        }
    }, 600_000);
});
