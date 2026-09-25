// Proves the .sql files run unchanged in duckdb-wasm, the engine the browser
// gets, and land the same database the CLI does.
//   bun test wasm
//
// No bundler and no build step: duckdb-wasm ships a node entry point that loads
// the same duckdb-eh.wasm binary the browser uses, so the engine under test is
// the real one even though the host is bun.
//
// The browser has no filesystem, so a file reaches read_csv by being registered
// under a name -- registerFileBuffer here, registerFileHandle or a URL in a page.
// load_file.sql reads getvariable('src') and never touches the OS, so the same
// script serves both hosts; `src` is a path in one and a registered name in the
// other.
//
// schema.sql opens with LOAD icu, which in wasm fetches the extension from
// extensions.duckdb.org on first use and caches it under ~/.duckdb. So this
// suite needs the network the first time it runs on a machine, and is offline
// after. That fetch is the browser's real startup cost, which is the point of
// exercising it here rather than mocking it away.

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createDuckDB, NODE_RUNTIME, ConsoleLogger, LogLevel,
} from "@duckdb/duckdb-wasm/blocking";

const REPO = import.meta.dir;
const DIST = join(REPO, "node_modules", "@duckdb", "duckdb-wasm", "dist");

const sqlFile = (name: string) => readFileSync(join(REPO, name), "utf8");

/** The summary both engines must agree on. Ints, so neither BigInt nor the
 *  CLI's text rendering can make two equal numbers look different. */
const SUMMARY = `
    SELECT (SELECT count(*) FROM trace)                        ::INT AS traces,
           (SELECT count(*) FROM object)                       ::INT AS objects,
           (SELECT count(*) FROM object WHERE direction='created')::INT AS created,
           (SELECT count(*) FROM hop)                          ::INT AS hops,
           (SELECT coalesce(sum(us), 0) FROM hop)              ::INT AS hop_us_total,
           (SELECT coalesce(sum(lost), 0) FROM trust)          ::INT AS lost,
           (SELECT coalesce(sum(outside_window), 0) FROM trust)::INT AS outside_window,
           (SELECT count(*) FROM shape_drift)                  ::INT AS drift,
           (SELECT count(*) FROM event_other)                  ::INT AS unrecognised,
           (SELECT count(*) FROM track)                        ::INT AS tracks`;

type Summary = Record<string, number>;

// --- the fixture: one object crossing one connection, logged at both ends ----

const REFERENCE_TIME = 1788560083342.7483;

const headerLine = (vantage: "client" | "server") => ({
    qlog_version: "0.3", qlog_format: "JSON-SEQ", title: "wasm-test",
    description: "MoQ Transport events",
    trace: {
        vantage_point: { type: vantage },
        common_fields: { reference_time: REFERENCE_TIME, time_format: "relative" },
        event_schemas: ["urn:ietf:params:qlog:events:moqt"],
    },
});

const ctrl = (time: number, dir: "created" | "parsed", data: Record<string, unknown>) => ({
    time, name: `moqt:control_message_${dir}`,
    data: { event_type: `control_message_${dir}`, stream_id: 0, ...data },
});

const sub = (time: number, id: number) =>
    ctrl(time, "created", {
        message_type: "subscribe", subscribe_id: id,
        track_namespace: "/bbb", track_name: "1.m4s", parameters: [],
    });

const subOk = (time: number, id: number, alias: number) =>
    ctrl(time, "parsed", {
        message_type: "subscribe_ok", subscribe_id: id, track_alias: alias,
        parameters: [], track_extensions: [],
    });

const sgHeader = (time: number, dir: "created" | "parsed", stream: number, alias: number) => ({
    time, name: `moqt:subgroup_header_${dir}`,
    data: {
        event_type: `subgroup_header_${dir}`, stream_id: stream,
        header_type: "SubgroupIdExt", track_alias: alias,
        group_id: 7, publisher_priority: 0, subgroup_id: 0,
    },
});

const sgObject = (time: number, dir: "created" | "parsed", stream: number, id: number) => ({
    time, name: `moqt:subgroup_object_${dir}`,
    data: {
        event_type: `subgroup_object_${dir}`, stream_id: stream,
        group_id: 7, subgroup_id: 0, object_id: id,
        extension_headers: [], object_payload_length: 1271,
    },
});

/** Sender and receiver of one connection, as mlog text. */
function fixture() {
    const lines = (head: unknown, events: unknown[]) =>
        [head, ...events].map((o) => JSON.stringify(o)).join("\n") + "\n";

    return {
        sender: lines(headerLine("client"), [
            sub(1, 5), subOk(2, 5, 5),
            sgHeader(9, "created", 2, 5),
            sgObject(10, "created", 2, 0),
            sgObject(20, "created", 2, 1),
            sgObject(30, "created", 2, 2),
        ]),
        receiver: lines(headerLine("server"), [
            sub(1, 4), subOk(2, 4, 4),
            sgHeader(59, "parsed", 2, 4),
            sgObject(60, "parsed", 2, 0),
            sgObject(70, "parsed", 2, 1),
            sgObject(80, "parsed", 2, 2),
        ]),
    };
}

// --- the two engines --------------------------------------------------------

/** Load through duckdb-wasm, with each mlog registered as a buffer. */
async function loadInWasm(files: { name: string; text: string; cid: string }[]) {
    const db = await createDuckDB(
        {
            mvp: { mainModule: `${DIST}/duckdb-mvp.wasm`, mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs` },
            eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
        },
        new ConsoleLogger(LogLevel.ERROR),
        NODE_RUNTIME,
    );
    await db.instantiate();

    // One connection for the whole load: session variables and the load's
    // transaction are both connection-scoped. See load_common.sql's header.
    const conn = db.connect();
    try {
        conn.query(sqlFile("schema.sql"));
        for (const f of files) {
            db.registerFileBuffer(f.name, new TextEncoder().encode(f.text));
            conn.query(`SET VARIABLE src = '${f.name}'; SET VARIABLE cid = '${f.cid}';`);
            conn.query(sqlFile("load_file.sql"));
            conn.query(sqlFile("load_common.sql"));
        }
        // toJSON() yields the column values; the shape is fixed by SUMMARY
        const row = conn.query(SUMMARY).toArray()[0]!.toJSON() as Summary;
        return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
    } finally {
        conn.close();
        db.reset();
    }
}

/** The same load through the duckdb CLI, for comparison. */
function loadInCli(files: { name: string; text: string; cid: string }[]) {
    const dir = mkdtempSync(join(tmpdir(), "mlog-wasm-cli-"));
    try {
        const db = join(dir, "cli.db");
        for (const f of files) {
            const path = join(dir, f.name);
            writeFileSync(path, f.text);
            const r = Bun.spawnSync([
                "duckdb", db,
                "-f", join(REPO, "schema.sql"),
                "-c", `SET VARIABLE src = '${path}'; SET VARIABLE cid = '${f.cid}';`,
                "-f", join(REPO, "load_file.sql"),
                "-f", join(REPO, "load_common.sql"),
            ]);
            if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        }
        const q = Bun.spawnSync(["duckdb", "-json", db, "-c", SUMMARY]);
        if (q.exitCode !== 0) throw new Error(q.stderr.toString());
        // duckdb -json emits one object per row; SUMMARY returns exactly one
        return (JSON.parse(q.stdout.toString()) as Summary[])[0]!;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// --- tests ------------------------------------------------------------------

test("schema.sql runs in duckdb-wasm", async () => {
    const db = await createDuckDB(
        {
            mvp: { mainModule: `${DIST}/duckdb-mvp.wasm`, mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs` },
            eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
        },
        new ConsoleLogger(LogLevel.ERROR),
        NODE_RUNTIME,
    );
    await db.instantiate();
    const conn = db.connect();
    try {
        conn.query(sqlFile("schema.sql"));
        // every view the charts read must exist, not just the tables
        const views = conn.query(
            `SELECT count(*)::INT AS n FROM duckdb_views()
             WHERE view_name IN ('object','hop','dwell','trust','event','shape_drift')`,
        ).toArray()[0]!.toJSON() as { n: number };
        expect(Number(views.n)).toBe(6);

        // schema.sql pins the zone, so a timestamp reads the same here as in the
        // CLI. Without this the browser would render UTC and the CLI local.
        const tz = conn.query("SELECT current_setting('TimeZone') AS tz")
            .toArray()[0]!.toJSON() as { tz: string };
        expect(tz.tz).toBe("UTC");

        // and the expression that needs ICU actually binds
        const w = conn.query(
            "SELECT (to_timestamp(1788560083.342748) + to_microseconds(5))::VARCHAR AS x",
        ).toArray()[0]!.toJSON() as { x: string };
        expect(w.x).toContain("+00");
    } finally {
        conn.close();
        db.reset();
    }
});

test("a registered buffer loads in wasm and matches the CLI exactly", async () => {
    const f = fixture();
    const files = [
        { name: "sender.mlog", text: f.sender, cid: "c1" },
        { name: "receiver.mlog", text: f.receiver, cid: "c1" },
    ];

    const [wasm, cli] = [await loadInWasm(files), loadInCli(files)];

    // the load is not vacuously empty
    expect(wasm.traces).toBe(2);
    expect(wasm.objects).toBe(6);
    expect(wasm.created).toBe(3);
    expect(wasm.hops).toBe(3);
    expect(wasm.hop_us_total).toBe(150_000);   // 50ms + 50ms + 50ms
    expect(wasm.lost).toBe(0);
    expect(wasm.drift).toBe(0);
    expect(wasm.unrecognised).toBe(0);

    // and the two engines agree on every column
    expect(wasm).toEqual(cli);
});

test("several registered buffers accumulate into one trace", async () => {
    // The browser's streaming path. src changes per chunk while the trace's
    // identity must not -- which is what trace_name is for.
    const f = fixture();
    const lines = f.sender.trimEnd().split("\n");
    const db = await createDuckDB(
        {
            mvp: { mainModule: `${DIST}/duckdb-mvp.wasm`, mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs` },
            eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
        },
        new ConsoleLogger(LogLevel.ERROR),
        NODE_RUNTIME,
    );
    await db.instantiate();
    const conn = db.connect();
    try {
        conn.query(sqlFile("schema.sql"));

        // one line per chunk, header first -- the worst case for accumulation
        for (const [i, line] of lines.entries()) {
            const name = `chunk-${i}.mlog`;
            db.registerFileBuffer(name, new TextEncoder().encode(line + "\n"));
            conn.query(`SET VARIABLE src = '${name}';`
                     + ` SET VARIABLE trace_name = 'sender.mlog';`
                     + ` SET VARIABLE cid = 'c1';`);
            conn.query(sqlFile("load_file.sql"));
            conn.query(sqlFile("load_common.sql"));
        }

        // one trace, filed under trace_name and not under any chunk's src
        const rows = conn.query(
            "SELECT trace_id::INT AS trace_id, filename FROM trace",
        ).toArray().map((r) => r.toJSON()) as { trace_id: number; filename: string }[];
        expect(rows).toEqual([{ trace_id: 1, filename: "sender.mlog" }]);

        // and every chunk's rows landed under it
        const n = conn.query(
            "SELECT count(*)::INT AS objects FROM object",
        ).toArray()[0]!.toJSON() as { objects: number };
        expect(Number(n.objects)).toBe(3);
    } finally {
        conn.close();
        db.reset();
    }
});

test("trace_name is spent, so an override cannot leak into the next load", async () => {
    const f = fixture();
    const db = await createDuckDB(
        {
            mvp: { mainModule: `${DIST}/duckdb-mvp.wasm`, mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs` },
            eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
        },
        new ConsoleLogger(LogLevel.ERROR),
        NODE_RUNTIME,
    );
    await db.instantiate();
    const conn = db.connect();
    try {
        conn.query(sqlFile("schema.sql"));

        db.registerFileBuffer("a.mlog", new TextEncoder().encode(f.sender));
        conn.query("SET VARIABLE src='a.mlog'; SET VARIABLE trace_name='named.mlog'; SET VARIABLE cid='c1';");
        conn.query(sqlFile("load_file.sql"));
        conn.query(sqlFile("load_common.sql"));

        // second load sets no trace_name; it must fall back to src, not reuse the
        // previous override -- which would collide on filename and be refused
        db.registerFileBuffer("b.mlog", new TextEncoder().encode(f.receiver));
        conn.query("SET VARIABLE src='b.mlog'; SET VARIABLE cid='c1';");
        conn.query(sqlFile("load_file.sql"));
        conn.query(sqlFile("load_common.sql"));

        const rows = conn.query("SELECT filename FROM trace ORDER BY trace_id")
            .toArray().map((r) => r.toJSON()) as { filename: string }[];
        expect(rows).toEqual([{ filename: "named.mlog" }, { filename: "b.mlog" }]);
    } finally {
        conn.close();
        db.reset();
    }
});

test("the guards fire in wasm too, not just under the CLI", async () => {
    // error() has to surface as a thrown exception, or a browser load would
    // accept a capture the CLI refuses
    const f = fixture();
    const db = await createDuckDB(
        {
            mvp: { mainModule: `${DIST}/duckdb-mvp.wasm`, mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs` },
            eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
        },
        new ConsoleLogger(LogLevel.ERROR),
        NODE_RUNTIME,
    );
    await db.instantiate();
    const conn = db.connect();
    try {
        conn.query(sqlFile("schema.sql"));
        db.registerFileBuffer("a.mlog", new TextEncoder().encode(f.sender));
        conn.query("SET VARIABLE src = 'a.mlog';");
        conn.query(sqlFile("load_file.sql"));
        conn.query(sqlFile("load_common.sql"));

        // same file, same name: filename UNIQUE must refuse it here as well
        conn.query("SET VARIABLE src = 'a.mlog';");
        conn.query(sqlFile("load_file.sql"));
        expect(() => conn.query(sqlFile("load_common.sql"))).toThrow(/filename/);
    } finally {
        conn.close();
        db.reset();
    }
});
