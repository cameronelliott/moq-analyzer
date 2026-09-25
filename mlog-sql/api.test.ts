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
    type Engine, type TraceSource,
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

const EXPECTED_LEGS = [
    { sub_cid: "sub1", leg_no: 1, leg: "pub -> relay", n: 3, mean_ms: 50, median_ms: 50, p95_ms: 50 },
    { sub_cid: "sub1", leg_no: 2, leg: "relay dwell",  n: 3, mean_ms: 1,  median_ms: 1,  p95_ms: 1 },
    { sub_cid: "sub1", leg_no: 3, leg: "relay -> sub", n: 3, mean_ms: 39, median_ms: 39, p95_ms: 39 },
];

const EXPECTED_TRUST = [
    { cid: "pub",  sender_is: "client", sent: 3, received: 3, joined: 3, lost: 0, outside_window: 0, negative_hops: 0 },
    { cid: "sub1", sender_is: "server", sent: 3, received: 3, joined: 3, lost: 0, outside_window: 0, negative_hops: 0 },
];

const DUPLICATE_AUDIT = readFileSync(join(REPO, "test-duplicated-mlog.sql"), "utf8");

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
        expect(Object.keys(await import("./api")).sort()).toEqual(["CaptureError", "openCapture"]);
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
            await expect(openCapture(engine, fixtureSources())).rejects.toThrow(/already holds/);
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
            const trust = await cap.trust();
            expect(trust).toHaveLength(5);
            for (const r of trust) {
                expect(r.sender_is).toBe(r.cid === PUBLISHER ? "client" : "server");
                expect(r.negative_hops).toBe(0);
            }

            const audit = await (await engine.connect()).query(DUPLICATE_AUDIT);
            expect(audit).toEqual([]);

            console.log(`real-6pop: loaded in ${(loadMs / 1000).toFixed(1)} s;`
                + ` leg 1 medians ${leg1.map((m) => m.toFixed(2)).join(", ")} ms`);
        } finally {
            reset();
        }
    }, 600_000);
});
