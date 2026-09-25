// Proves the .sql files ingest a File the way a browser tab will: through
// BROWSER_FILEREADER, which reads ranges out of the File rather than copying it
// into wasm memory. This is the path an <input type="file"> feeds.
//   bun test browser
//
// Needs chromium on PATH. Skipped, loudly, when it is absent, so the rest of the
// suite still runs on a machine without one.
//
// No browser-driver dependency and no bundler: Bun.serve hands out the page, the
// duckdb dist and the .sql files, and the browser is driven over the DevTools
// protocol directly.
//
// duckdb-browser.mjs is not self-contained: duckdb-wasm returns results as
// Apache Arrow tables, so its browser build imports apache-arrow, which imports
// tslib and flatbuffers. The node build hides this because require resolves them.
//
// So the page gets one Bun.build of that entry -- 137 modules, 0.41 MB, ~20ms,
// done in memory with nothing written to disk. An import map was the other
// option and it was worse: arrow ships node-only files, so which bare specifiers
// the browser actually reaches is a guess, and the guess would rot on a version
// bump. Bundling is also what a real page would do.
//
// Resolution failures here happen at import time, so the page never assigns its
// result at all -- hence the error path below reports the console rather than a
// rejected promise, which is the only way that cause is visible.
//
// wasm.test.ts covers the same SQL through registerFileBuffer, where the bytes
// are handed over whole. The two differ only in how read_csv gets at them, which
// is exactly what this file exists to check.

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = import.meta.dir;
const DIST = join(REPO, "node_modules", "@duckdb", "duckdb-wasm", "dist");
const CHROMIUM = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
    .find((p) => existsSync(p));

// --- the fixture: one trace, three objects on one subgroup stream ------------

const REFERENCE_TIME = 1788560083342.7483;

const mlog = () => {
    const head = {
        qlog_version: "0.3", qlog_format: "JSON-SEQ", title: "browser-test",
        description: "MoQ Transport events",
        trace: {
            vantage_point: { type: "client" },
            common_fields: { reference_time: REFERENCE_TIME, time_format: "relative" },
            event_schemas: ["urn:ietf:params:qlog:events:moqt"],
        },
    };
    const ctrl = (time: number, dir: string, data: Record<string, unknown>) => ({
        time, name: `moqt:control_message_${dir}`,
        data: { event_type: `control_message_${dir}`, stream_id: 0, ...data },
    });
    const events: unknown[] = [
        // an apostrophe, which would need escaping on any string-interpolated path
        ctrl(1, "created", {
            message_type: "subscribe", subscribe_id: 5,
            track_namespace: "/o'brien", track_name: "it's-1.m4s", parameters: [],
        }),
        ctrl(2, "parsed", {
            message_type: "subscribe_ok", subscribe_id: 5, track_alias: 5,
            parameters: [], track_extensions: [],
        }),
        {
            time: 9, name: "moqt:subgroup_header_created",
            data: {
                event_type: "subgroup_header_created", stream_id: 2,
                header_type: "SubgroupIdExt", track_alias: 5,
                group_id: 7, publisher_priority: 0, subgroup_id: 0,
            },
        },
    ];
    for (let i = 0; i < 3; i++) {
        events.push({
            time: 10 + i * 10, name: "moqt:subgroup_object_created",
            data: {
                event_type: "subgroup_object_created", stream_id: 2,
                group_id: 7, subgroup_id: 0, object_id: i,
                extension_headers: [], object_payload_length: 1271,
            },
        });
    }
    return [head, ...events].map((o) => JSON.stringify(o)).join("\n") + "\n";
};

const SUMMARY = `
    SELECT (SELECT count(*) FROM trace)                   ::INT AS traces,
           (SELECT count(*) FROM object)                  ::INT AS objects,
           (SELECT count(*) FROM control_message)         ::INT AS ctl,
           (SELECT count(*) FROM shape_drift)             ::INT AS drift,
           (SELECT count(*) FROM event_other)             ::INT AS unrecognised,
           (SELECT any_value(track_name) FROM object)            AS track_name,
           (SELECT any_value(filename)   FROM trace)             AS filename`;

// --- the page ---------------------------------------------------------------

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>mlog-sql browser ingest</title>
<script type="module">
import * as duckdb from '/duckdb.mjs';

const text = async (u) => (await fetch(u)).text();

window.__done = (async () => {
    const worker = new Worker('/dist/duckdb-browser-eh.worker.js');
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR), worker);
    await db.instantiate('/dist/duckdb-eh.wasm');

    // A real File, as an <input type="file"> hands one over. registerFileHandle
    // with BROWSER_FILEREADER makes duckdb read ranges from it via Blob.slice,
    // so the bytes are never copied into the wasm heap in one go.
    const bytes = new Uint8Array(await (await fetch('/fixture.mlog')).arrayBuffer());
    const file = new File([bytes], 'sender.mlog', { type: 'application/octet-stream' });
    await db.registerFileHandle('sender.mlog', file,
                                duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);

    const conn = await db.connect();
    await conn.query(await text('/sql/schema.sql'));
    await conn.query("SET VARIABLE src = 'sender.mlog';");
    await conn.query(await text('/sql/load.sql'));

    const rows = (await conn.query(await text('/sql/summary.sql'))).toArray()
        .map((r) => r.toJSON());
    await conn.close();
    // CDP cannot serialise BigInt, so hand back text
    return JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
})().catch((e) => 'ERROR: ' + (e && e.stack ? e.stack : String(e)));
</script>`;

// --- CDP, by hand -----------------------------------------------------------

type CdpMessage = { id?: number; method?: string; result?: unknown; params?: unknown };

/** Minimal DevTools client: navigate, evaluate, collect. */
class Cdp {
    private ws: WebSocket;
    private next = 1;
    private pending = new Map<number, (m: CdpMessage) => void>();
    readonly logs: string[] = [];

    private constructor(ws: WebSocket) {
        this.ws = ws;
        this.ws.addEventListener("message", (e) => {
            // DevTools always sends JSON text frames
            const m = JSON.parse(String(e.data)) as CdpMessage;
            if (m.id !== undefined) this.pending.get(m.id)?.(m);
            else if (m.method === "Runtime.consoleAPICalled"
                  || m.method === "Runtime.exceptionThrown"
                  || m.method === "Log.entryAdded") {
                this.logs.push(m.method + " " + JSON.stringify(m.params));
            }
        });
    }

    static async connect(url: string) {
        const ws = new WebSocket(url);
        await new Promise<void>((ok, bad) => {
            ws.addEventListener("open", () => ok(), { once: true });
            ws.addEventListener("error", () => bad(new Error("cdp connect failed")), { once: true });
        });
        return new Cdp(ws);
    }

    send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = this.next++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, (m) => {
                this.pending.delete(id);
                const r = m.result as { exceptionDetails?: unknown } | undefined;
                if (r?.exceptionDetails) reject(new Error(JSON.stringify(r.exceptionDetails)));
                else resolve(m.result as T);
            });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    close() { this.ws.close(); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serve the page, the duckdb dist, the .sql files and the fixture. */
function serve(files: Record<string, { body: string | Uint8Array; type: string }>) {
    return Bun.serve({
        port: 0,
        fetch(req) {
            const path = new URL(req.url).pathname;
            // The worker script and the wasm are fetched by URL rather than
            // imported, so they are served from the real dist untouched.
            if (path.startsWith("/dist/")) {
                return new Response(Bun.file(join(DIST, path.slice("/dist/".length))));
            }
            const hit = files[path];
            if (!hit) return new Response("not found", { status: 404 });
            return new Response(hit.body, { headers: { "content-type": hit.type } });
        },
    });
}

const sqlText = (n: string) => readFileSync(join(REPO, n), "utf8");

// --- the test ---------------------------------------------------------------

test("a File is ingested through BROWSER_FILEREADER, matching the CLI", async () => {
    if (CHROMIUM === undefined) {
        throw new Error("chromium not found; install it or skip this file");
    }
    const log = mlog();

    // duckdb's browser entry, with arrow and friends folded in. In memory.
    const built = await Bun.build({
        entrypoints: [join(DIST, "duckdb-browser.mjs")],
        target: "browser",
        format: "esm",
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    const duckdbJs = await built.outputs[0]!.text();

    const server = serve({
        "/": { body: PAGE, type: "text/html" },
        "/duckdb.mjs": { body: duckdbJs, type: "text/javascript" },
        "/fixture.mlog": { body: log, type: "application/octet-stream" },
        "/sql/schema.sql": { body: sqlText("schema.sql"), type: "text/plain" },
        "/sql/load.sql": { body: sqlText("load.sql"), type: "text/plain" },
        "/sql/summary.sql": { body: SUMMARY, type: "text/plain" },
    });
    const profile = mkdtempSync(join(tmpdir(), "mlog-chromium-"));
    let chrome: Bun.Subprocess | undefined;
    try {
        const port = 9333 + (process.pid % 500);
        chrome = Bun.spawn([
            CHROMIUM,
            "--headless=new",
            "--no-sandbox",                 // required in a container
            "--disable-dev-shm-usage",
            "--disable-gpu",
            `--user-data-dir=${profile}`,
            `--remote-debugging-port=${port}`,
            `http://127.0.0.1:${server.port}/`,
        ], { stdout: "pipe", stderr: "pipe" });

        // wait for the debugging endpoint, then find the page target
        let wsUrl = "";
        for (let i = 0; i < 100 && wsUrl === ""; i++) {
            await sleep(100);
            try {
                const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as
                    { type: string; url: string; webSocketDebuggerUrl: string }[];
                const page = list.find((t) => t.type === "page" && t.url.includes(String(server.port)));
                if (page) wsUrl = page.webSocketDebuggerUrl;
            } catch { /* not up yet */ }
        }
        expect(wsUrl).not.toBe("");

        const cdp = await Cdp.connect(wsUrl);
        try {
            await cdp.send("Runtime.enable");
            await cdp.send("Log.enable");   // network and module-load failures
            // the page loaded before we attached, so run it again from a clean slate
            await cdp.send("Page.enable");
            await cdp.send("Page.reload", { ignoreCache: true });
            await sleep(500);
            // the module may still be loading, so wait for the page to publish it
            const r = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
                expression:
                    "(async () => { for (let i = 0; i < 600 && !window.__done; i++)"
                    + " await new Promise(r => setTimeout(r, 100)); return await window.__done; })()",
                awaitPromise: true,
                returnByValue: true,
            });
            const out = r.result.value;
            // A failure inside the module leaves __done unset rather than
            // rejected, so anything that is not the expected JSON array has to
            // surface the page's own console or the cause is invisible.
            if (typeof out !== "string" || !out.startsWith("[")) {
                throw new Error(`page returned ${JSON.stringify(out)}\nconsole:\n`
                    + (cdp.logs.length ? cdp.logs.join("\n") : "(nothing logged)"));
            }

            // the page returns its rows as JSON text; the shape is fixed by SUMMARY
            const rows = JSON.parse(out) as Record<string, unknown>[];
            const got = rows[0]!;

            expect(got.traces).toBe(1);
            expect(got.objects).toBe(3);
            expect(got.ctl).toBe(2);
            expect(got.drift).toBe(0);
            expect(got.unrecognised).toBe(0);
            // survives the File path with no escaping anywhere
            expect(got.track_name).toBe("it's-1.m4s");
            // src was the registered name, and that is what identifies the trace
            expect(got.filename).toBe("sender.mlog");

            // and the CLI agrees, on the same bytes
            const dir = mkdtempSync(join(tmpdir(), "mlog-browser-cli-"));
            try {
                const path = join(dir, "sender.mlog");
                writeFileSync(path, log);
                const db = join(dir, "cli.db");
                const load = Bun.spawnSync([
                    "duckdb", db,
                    "-f", join(REPO, "schema.sql"),
                    "-c", `SET VARIABLE src = '${path}'; SET VARIABLE trace_name = 'sender.mlog';`,
                    "-f", join(REPO, "load.sql"),
                ]);
                if (load.exitCode !== 0) throw new Error(load.stderr.toString());
                const q = Bun.spawnSync(["duckdb", "-json", db, "-c", SUMMARY]);
                // duckdb -json emits one object per row; SUMMARY returns exactly one
                const cli = (JSON.parse(q.stdout.toString()) as Record<string, unknown>[])[0]!;
                expect(got).toEqual(cli);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        } finally {
            cdp.close();
        }
    } finally {
        chrome?.kill();
        server.stop(true);
        rmSync(profile, { recursive: true, force: true });
    }
}, 180_000);
