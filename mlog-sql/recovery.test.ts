// Proves the two recoveries a stock moq-rs capture needs, against captures that
// did not need them.
//   bun test recovery
//
// The captures in a1/data were written by a moq-rs that logs real stream ids
// and a reference_time, so each one is its own ground truth:
//
//   stream ids       set every stream_id to 0, as stock moq-rs does, load, and
//                    require every Capture result to equal the original's.
//   reference_time   also remove it from the relay's traces, load, and require
//                    every dwell to differ from the original's by one constant
//                    per subscriber: the fastest real dwell. The test prints
//                    that constant, which is the error a reader sees.
//
// Comparing two loads as sorted rows is EXCEPT ALL in both directions: the two
// captures are in two databases, so SQL cannot compare them.
//
// The a1/data tests skip when the directory is absent. Like wasm.test.ts, the
// first run fetches the ICU and JSON extensions.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    createDuckDB, NODE_RUNTIME, ConsoleLogger, LogLevel,
} from "@duckdb/duckdb-wasm/blocking";
import {
    openCapture, RECOVERED_DWELL,
    type Capture, type Conn, type Engine, type Measure, type TraceSource,
} from "./api";
import { recordChunks } from "./api-internal";
import {
    field, hasRealStreamIds, isRealStreamId, parseRecord, records, repair, withStreamIds,
} from "./recover-stream-ids";

const REPO = import.meta.dir;
const DIST = join(REPO, "node_modules", "@duckdb", "duckdb-wasm", "dist");
const DATA = join(REPO, "..", "..", "a1", "data");
const VANILLA_FIXTURE = join(REPO, "fixtures", "vanilla-stock.mlog");

// --- engine and input -------------------------------------------------------

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

function streamOf(text: string, piece = 256 * 1024): ReadableStream<Uint8Array> {
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

interface TraceText { name: string; cid: string; text: string; }

/** The mlog files of one a1/data directory. `only` keeps one end. */
function traceTexts(dir: string, only?: "client" | "server"): TraceText[] {
    const out: TraceText[] = [];
    for (const file of readdirSync(dir).sort()) {
        const m = /^(.+)_(client|server)\.mlog$/.exec(file);
        const cid = m?.[1];
        if (cid === undefined || (only !== undefined && m?.[2] !== only)) continue;
        out.push({ name: file, cid, text: readFileSync(join(dir, file), "utf8") });
    }
    return out;
}

const sources = (traces: TraceText[]): TraceSource[] =>
    traces.map((t) => ({ name: t.name, cid: t.cid, stream: streamOf(t.text) }));

/**
 * One trace as stock moq-rs would have written it: stream_id 0 on every event.
 * With `noReferenceTime`, the header also loses common_fields, which is where
 * reference_time and time_format live.
 */
function asStock(text: string, noReferenceTime: boolean): string {
    return records(text).map((line) => {
        const rec = parseRecord(line);
        const data = field(rec, "data");
        if (typeof data === "object" && data !== null && "stream_id" in data) {
            Reflect.set(data, "stream_id", 0);
        }
        const trace = field(rec, "trace");
        if (noReferenceTime && typeof trace === "object" && trace !== null) {
            Reflect.deleteProperty(trace, "common_fields");
        }
        return "\x1e" + JSON.stringify(rec) + "\n";
    }).join("");
}

const stock = (traces: TraceText[], noReferenceTime: boolean): TraceText[] =>
    traces.map((t) => ({ ...t, text: asStock(t.text, noReferenceTime) }));

// --- what is compared -------------------------------------------------------

const MEASURES: readonly Measure[] = ["end to end", "relay dwell", "interarrival", "bitrate"];

/** Every result a Capture gives, but `recovery`, which is what differs. */
async function everything(capture: Capture) {
    const distributions = [];
    for (const m of MEASURES) distributions.push(await capture.distribution(m));
    return {
        legSummary: await capture.legSummary(),
        trust: await capture.trust(),
        coverage: await capture.coverage(),
        jitterSummary: await capture.jitterSummary(),
        jitterSeries: await capture.jitterSeries(),
        relaySeries: await capture.relaySeries(),
        objectBitrateSummary: await capture.objectBitrateSummary(),
        objectBitrateSeries: await capture.objectBitrateSeries(),
        distributions,
    };
}

interface Dwell { sub: string; key: string; us: number; }

/** Every dwell row: the subscriber, the object, and the microseconds. */
async function dwells(conn: Conn): Promise<Dwell[]> {
    const rows = await conn.query(
        `SELECT out_cid AS sub,
                concat_ws('/', track_namespace, track_name, group_id, subgroup_id, object_id) AS key,
                us::DOUBLE AS us
         FROM dwell
         ORDER BY sub, key`);
    return rows.map((r) => {
        const sub = field(r, "sub");
        const key = field(r, "key");
        const us = field(r, "us");
        if (typeof sub !== "string" || typeof key !== "string" || typeof us !== "number") {
            throw new Error(`unexpected dwell row: ${JSON.stringify(r)}`);
        }
        return { sub, key, us };
    });
}

function bySub(rows: Dwell[]): Map<string, Dwell[]> {
    const out = new Map<string, Dwell[]>();
    for (const r of rows) {
        const list = out.get(r.sub);
        if (list) list.push(r); else out.set(r.sub, [r]);
    }
    return out;
}

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? NaN;
};

// --- no capture needed ------------------------------------------------------

describe("which traces need stream ids recovered", () => {
    test("a real subgroup stream id is a unidirectional one", () => {
        for (const id of [2, 3, 6, 7, 63, 4014]) expect(isRealStreamId(id)).toBe(true);
        for (const id of [0, 1, 4, 5, 8, 9, 2.5, "2", null, undefined]) {
            expect(isRealStreamId(id)).toBe(false);
        }
    });

    test("the first subgroup header decides, and no header decides nothing", () => {
        const head = '{"qlog_version":"0.3","trace":{}}';
        const ctrl = '{"time":1,"name":"moqt:control_message_parsed","data":{"stream_id":0}}';
        const header = (id: number) =>
            `{"time":2,"name":"moqt:subgroup_header_parsed","data":{"stream_id":${id}}}`;
        expect(hasRealStreamIds([head, ctrl].join("\n"))).toBeUndefined();
        expect(hasRealStreamIds([head, ctrl, header(6), header(0)].join("\n"))).toBe(true);
        expect(hasRealStreamIds([head, ctrl, header(0), header(6)].join("\n"))).toBe(false);
    });
});

describe("repair, on the stock moq-rs fixture", () => {
    const raw = readFileSync(VANILLA_FIXTURE, "utf8");

    test("the fixture is a stock trace", () => {
        expect(hasRealStreamIds(raw)).toBe(false);
    });

    test("recovered ids are multiples of 4, never 0, and the header says so", () => {
        const { records: out, stats } = repair(raw);
        const parsed = out.map((r) => parseRecord(r.slice(1)));

        const trace = field(parsed[0], "trace");
        expect(field(trace, "moq_stream_id_source")).toBe("recovered");
        expect(field(trace, "moq_stream_id_uncertain")).toBe(stats.uncertain);
        expect(field(trace, "moq_stream_id_unresolved")).toBe(0);

        const ids: number[] = [];
        for (const rec of parsed) {
            const name = field(rec, "name");
            if (typeof name !== "string" || !name.startsWith("moqt:subgroup_")) continue;
            const id = field(field(rec, "data"), "stream_id");
            if (typeof id !== "number") throw new Error("a subgroup event without an id");
            ids.push(id);
        }
        expect(ids.length).toBeGreaterThan(0);
        expect(stats.objects).toBeGreaterThan(0);
        for (const id of ids) {
            expect(id).toBeGreaterThan(0);
            expect(id % 4).toBe(0);
            expect(isRealStreamId(id)).toBe(false);
        }
        // Every record but the dropped ones is still there, in order.
        expect(out.length).toBe(records(raw).length - stats.unresolved);
    });

    test("openCapture loads it, and says what it recovered", async () => {
        const capture = await openCapture(await nodeEngine(), [
            { name: "stock_server.mlog", cid: "stock", stream: streamOf(raw) },
        ]);
        expect(await capture.recovery()).toEqual([{
            cid: "stock", trace: "stock_server.mlog", vantage_point: "server",
            stream_ids: "recovered", stream_ids_uncertain: 0, stream_ids_unresolved: 0,
            reference_time: "none", clock_matched: null, clock_near_floor: null,
        }]);
        const bitrate = await capture.objectBitrateSummary();
        expect(bitrate.length).toBeGreaterThan(0);
    }, 60_000);
});

describe("withStreamIds", () => {
    const collect = async (text: string, chunkBytes: number) => {
        const parts: string[] = [];
        const decoder = new TextDecoder();
        for await (const c of withStreamIds(recordChunks(streamOf(text, 100), chunkBytes), chunkBytes)) {
            parts.push(decoder.decode(c));
        }
        return parts.join("");
    };

    test("a trace with real ids passes through byte for byte", async () => {
        const text = [
            '{"qlog_version":"0.3","trace":{"vantage_point":{"type":"client"}}}',
            '{"time":1,"name":"moqt:subgroup_header_parsed","data":{"stream_id":6,"track_alias":0,"group_id":0,"subgroup_id":0}}',
            '{"time":2,"name":"moqt:subgroup_object_parsed","data":{"stream_id":6,"group_id":0,"subgroup_id":0,"object_id":0,"object_payload_length":9}}',
        ].map((l) => "\x1e" + l + "\n").join("");
        expect(await collect(text, 64)).toBe(text);
    });

    test("a stock trace comes out repaired, whatever the chunk size", async () => {
        const raw = readFileSync(VANILLA_FIXTURE, "utf8");
        const whole = repair(raw).records.join("");
        expect(await collect(raw, 64)).toBe(whole);
        expect(await collect(raw, 1 << 20)).toBe(whole);
    });
});

test("RECOVERED_DWELL says the error is one-sided and gives its range", () => {
    expect(RECOVERED_DWELL.note).toContain("never too high");
    expect(RECOVERED_DWELL.note).toContain("under 10 µs");
    // The range the measurement below prints, over n1, n4 and real-6pop.
    expect(RECOVERED_DWELL.typicalErrorUs).toEqual({ low: 3, high: 9 });
});

// --- against a1/data --------------------------------------------------------

describe.skipIf(!existsSync(DATA))("against a1/data", () => {
    const REAL = ["n1", "n1-clients", "n1-relay", "n4", "n4-clients", "n4-ragged", "n4-uniform",
                  "real-6pop-demo"];

    test("the detector tells the captures apart", () => {
        for (const dir of REAL) {
            const traces = traceTexts(join(DATA, dir));
            expect(traces.length).toBeGreaterThan(0);
            for (const t of traces) expect([dir, t.name, hasRealStreamIds(t.text)]).toEqual([dir, t.name, true]);
        }
        const vanilla = traceTexts(join(DATA, "vanilla"));
        expect(vanilla.length).toBe(2);
        for (const t of vanilla) expect(hasRealStreamIds(t.text)).toBe(false);
    });

    for (const dir of ["n1", "n4", "n1-relay"]) {
        test(`${dir}: zeroed stream ids, recovered, give every result back`, async () => {
            const traces = traceTexts(join(DATA, dir));
            const original = await openCapture(await nodeEngine(), sources(traces));
            const recovered = await openCapture(await nodeEngine(), sources(stock(traces, false)));

            for (const row of await original.recovery()) {
                expect(row.stream_ids).toBe("logged");
                expect(row.reference_time).toBe("logged");
            }
            for (const row of await recovered.recovery()) {
                expect(row.stream_ids).toBe("recovered");
                expect(row.stream_ids_unresolved).toBe(0);
                expect(row.reference_time).toBe("logged");
            }
            const want = await everything(original);
            expect(want.objectBitrateSeries.length).toBeGreaterThan(0);
            expect(await everything(recovered)).toEqual(want);
        }, 300_000);
    }

    test("vanilla: a real stock capture gives relay dwell", async () => {
        // No ground truth here: two relay traces from stock moq-rs. a1 matched
        // 1545 objects and got a 427 us median by the same method.
        const capture = await openCapture(await nodeEngine(), sources(traceTexts(join(DATA, "vanilla"))));
        const recovery = await capture.recovery();
        expect(recovery.map((r) => [r.stream_ids, r.stream_ids_unresolved, r.reference_time]).sort())
            .toEqual([["recovered", 0, "none"], ["recovered", 0, "recovered"]]);

        const lined = recovery.find((r) => r.reference_time === "recovered");
        expect(lined?.clock_matched).toBe(1545);
        expect(lined?.clock_near_floor).toBeGreaterThan(10);

        const dwell = await capture.distribution("relay dwell");
        expect(dwell?.min).toBe(0);
        // a2 leaves held objects out of the distribution, so not a1's number exactly
        expect(dwell?.p50).toBeGreaterThan(0.3);
        expect(dwell?.p50).toBeLessThan(0.5);
        expect(await capture.distribution("end to end")).toBeNull();
        expect(dwell?.measured_at).toBe("relay");

        // A relay operator's logs: bitrate is what the relay sent the
        // subscriber, and interarrival is the gap at the relay. Both say so.
        const bitrate = await capture.distribution("bitrate");
        expect(bitrate?.measured_at).toBe("relay");
        expect(bitrate?.unit).toBe("kbit/s");
        // object_bitrate_summary's `all` row for the relay's sending end
        const sent = (await capture.objectBitrateSummary()).find((r) =>
            r.vantage_point === "server" && r.direction === "created" && r.scope === "all");
        expect(bitrate?.n).toBe(sent?.seconds);
        expect(bitrate?.p50).toBe(sent?.median_kbit_s ?? NaN);
        const gaps = await capture.distribution("interarrival");
        expect(gaps?.measured_at).toBe("relay");
        expect(gaps?.n).toBeGreaterThan(1000);
        expect((await capture.legSummary()).map((l) => l.leg)).toEqual(["relay dwell"]);
        console.log(`vanilla: ${lined?.clock_matched} objects matched,`
            + ` ${lined?.clock_near_floor} within 50 us of the fastest,`
            + ` dwell median ${dwell?.p50} ms, p99 ${dwell?.p99} ms, n ${dwell?.n}`);
    }, 120_000);

    // The measurement. Relay traces only, as a relay operator has them.
    const MEASURED: { dir: string; label: string }[] = [
        { dir: "n1", label: "n1" },
        { dir: "n4", label: "n4" },
        { dir: join("real-6pop", "mlog-only"), label: "real-6pop" },
    ];

    for (const { dir, label } of MEASURED) {
        test.skipIf(!existsSync(join(DATA, dir)))(
            `${label}: recovered dwell is the true dwell less one constant`, async () => {
            const traces = traceTexts(join(DATA, dir), "server");

            const engineA = await nodeEngine();
            await openCapture(engineA, sources(traces));
            const truth = bySub(await dwells(await engineA.connect()));

            const engineB = await nodeEngine();
            const capture = await openCapture(engineB, sources(stock(traces, true)));
            const got = bySub(await dwells(await engineB.connect()));

            expect(truth.size).toBeGreaterThan(0);
            expect([...got.keys()]).toEqual([...truth.keys()]);

            const recovery = await capture.recovery();
            // One inbound trace keeps the stand-in; every outbound one is lined up.
            expect(recovery.filter((r) => r.reference_time === "none").length).toBe(1);
            expect(recovery.filter((r) => r.reference_time === "recovered").length).toBe(truth.size);
            for (const r of recovery) expect(r.stream_ids_unresolved).toBe(0);

            for (const [sub, want] of truth) {
                const have = got.get(sub) ?? [];
                const error = Math.min(...want.map((d) => d.us));
                // The same objects, each low by exactly the fastest real dwell.
                expect(have.map((d) => d.key)).toEqual(want.map((d) => d.key));
                const gaps = new Set(want.map((d, i) => d.us - (have[i]?.us ?? NaN)));
                expect([...gaps]).toEqual([error]);
                // One-sided: never negative, and the fastest reads 0.
                expect(Math.min(...have.map((d) => d.us))).toBe(0);
                // "typically under 10 us", as RECOVERED_DWELL.note says.
                expect(error).toBeGreaterThanOrEqual(0);
                expect(error).toBeLessThan(10);

                const row = recovery.find((r) => r.cid === sub);
                expect(row?.clock_matched).toBe(want.length);
                console.log(`${label} ${sub.slice(0, 8)}: ${want.length} objects,`
                    + ` error ${error} us, true median ${median(want.map((d) => d.us))} us,`
                    + ` ${row?.clock_near_floor} within 50 us of the fastest`);
            }
        }, 600_000);
    }
});
