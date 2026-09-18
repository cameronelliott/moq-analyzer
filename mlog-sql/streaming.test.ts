// Proves load_lines.sql can ingest an mlog as a stream of chunks and land the
// same database as load_file.sql ingesting the whole file at once.
//   bun test streaming
//
// Chunking is where the loader's per-statement assumptions show up: the track
// table is derived from a subscribe/subscribe_ok pair that can straddle a
// boundary, and the shape census has to accumulate rather than append. Every
// chunk size splits those differently, so the sweep is the point.

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = import.meta.dir;
const LOG = join(REPO, "mlog.jsonl");

// Every table the loader writes. trace.loaded_at is wall-clock at insert time,
// so it is the one column that legitimately differs between two loads.
const TABLES: [string, string][] = [
    ["trace", "* EXCLUDE (loaded_at)"],
    ["track", "*"],
    ["control_message", "*"],
    ["subgroup_stream", "*"],
    ["subgroup_object", "*"],
    ["event_other", "*"],
    ["shape", "*"],
];

function duck(args: string[], stdin?: string) {
    const r = Bun.spawnSync({
        cmd: ["duckdb", ...args],
        stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    });
    if (r.exitCode !== 0) {
        throw new Error(`duckdb failed: ${r.stderr.toString()}\n${r.stdout.toString()}`);
    }
    return r.stdout.toString();
}

/** duckdb -json pretty-prints one array across lines; ATTACH and SET emit nothing,
 *  so stdout from each call below is exactly one result set. */
function json<T>(out: string): T[] {
    const t = out.trim();
    return t === "" ? [] : JSON.parse(t);
}

/** Whole-file ingest: the reference every streamed load is measured against. */
function loadFile(db: string, log: string) {
    duck([
        db,
        "-f", join(REPO, "schema.sql"),
        "-c", `set variable src='${log}';`,
        "-f", join(REPO, "load_file.sql"),
        "-f", join(REPO, "load_common.sql"),
    ]);
}

/** Chunked ingest, all chunks through a single long-lived duckdb process. */
function loadStream(db: string, lines: string[], chunkSize: number, srcName: string) {
    const sql = [
        `.read ${join(REPO, "schema.sql")}`,
        `set variable filename='${srcName}';`,
    ];
    for (let i = 0; i < lines.length; i += chunkSize) {
        // lines reach DuckDB as SQL text, so single quotes must be doubled
        const chunk = lines.slice(i, i + chunkSize).join("\n").replaceAll("'", "''");
        sql.push(`set variable lines='${chunk}';`,
            `.read ${join(REPO, "load_lines.sql")}`,
            `.read ${join(REPO, "load_common.sql")}`);
    }
    duck([db], sql.join("\n") + "\n");
}

type Diff = { tbl: string; only_stream: number; only_file: number };

function diff(streamDb: string, fileDb: string): Diff[] {
    const parts = TABLES.map(([t, cols]) => `
        SELECT '${t}' AS tbl,
          (SELECT count(*) FROM ((SELECT ${cols} FROM s.${t})
                          EXCEPT ALL (SELECT ${cols} FROM f.${t}))) AS only_stream,
          (SELECT count(*) FROM ((SELECT ${cols} FROM f.${t})
                          EXCEPT ALL (SELECT ${cols} FROM s.${t}))) AS only_file`);
    return json<Diff>(duck([
        "-json",
        "-c", `ATTACH '${streamDb}' AS s (READ_ONLY); ATTACH '${fileDb}' AS f (READ_ONLY);`,
        "-c", parts.join(" UNION ALL ") + " ORDER BY tbl;",
    ]));
}

/** The one row a scalar query must return; fails loudly rather than undefined. */
function one<T>(rows: T[], what: string): T {
    const [row, ...rest] = rows;
    if (row === undefined || rest.length > 0) {
        throw new Error(`${what}: expected exactly 1 row, got ${rows.length}`);
    }
    return row;
}

function counts(db: string) {
    return one(json<{ objects: number; streams: number; tracks: number; shapes: number; ctrl: number }>(
        duck(["-json", db, "-c", `SELECT
            (SELECT count(*) FROM subgroup_object) AS objects,
            (SELECT count(*) FROM subgroup_stream) AS streams,
            (SELECT count(*) FROM track)           AS tracks,
            (SELECT count(*) FROM shape)           AS shapes,
            (SELECT count(*) FROM control_message) AS ctrl;`]),
    ), "counts");
}

/** First n lines of the real log, written to a temp file. Returns both forms. */
function fixture(dir: string, n: number) {
    const lines = readFileSync(LOG, "utf8").split("\n").slice(0, n).filter((l) => l !== "");
    const path = join(dir, "fixture.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    return { lines, path };
}

test("every chunk size from 1 to 100 lands the same database as one file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mlog-stream-"));
    try {
        // 150 lines covers all four event types, three subgroup streams, and all
        // three subscribe/subscribe_ok pairs -- so chunk boundaries fall between
        // a subscribe and its ok, which is what broke the track table.
        const { lines, path } = fixture(dir, 150);

        const fileDb = join(dir, "file.db");
        loadFile(fileDb, path);

        const want = counts(fileDb);
        expect(want.objects).toBe(140);
        expect(want.streams).toBe(3);
        expect(want.tracks).toBe(3);
        expect(want.ctrl).toBe(6);
        expect(want.shapes).toBe(4);

        const broken: string[] = [];
        for (let size = 1; size <= 100; size++) {
            const streamDb = join(dir, `stream-${size}.db`);
            loadStream(streamDb, lines, size, path);

            for (const d of diff(streamDb, fileDb)) {
                if (d.only_stream !== 0 || d.only_file !== 0) {
                    broken.push(`size=${size} ${d.tbl}: +${d.only_stream}/-${d.only_file}`);
                }
            }
            const got = counts(streamDb);
            if (got.shapes !== want.shapes) broken.push(`size=${size} shapes=${got.shapes}`);
            rmSync(streamDb, { force: true });
        }
        expect(broken).toEqual([]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, 300_000);

test("250 lines fed one at a time land the same database as one file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mlog-stream1-"));
    try {
        const { lines, path } = fixture(dir, 250);
        expect(lines).toHaveLength(250);

        const fileDb = join(dir, "file.db");
        const streamDb = join(dir, "stream.db");
        loadFile(fileDb, path);
        loadStream(streamDb, lines, 1, path);

        for (const d of diff(streamDb, fileDb)) {
            expect(d).toEqual({ tbl: d.tbl, only_stream: 0, only_file: 0 });
        }

        // and the load is not vacuously empty
        const got = counts(streamDb);
        expect(got).toEqual(counts(fileDb));
        expect(got.objects).toBeGreaterThan(200);
        expect(got.tracks).toBe(3);
        expect(got.shapes).toBe(4);

        // track is re-derived from the whole trace each chunk, so every alias must
        // still resolve to its name even though each subscribe and its subscribe_ok
        // arrived in separate chunks
        const tracks = json<{ track_alias: number; track_name: string }>(
            duck(["-json", streamDb, "-c",
                "SELECT track_alias, track_name FROM track ORDER BY track_alias"]),
        );
        expect(tracks).toEqual([
            { track_alias: 0, track_name: "0.mp4" },
            { track_alias: 2, track_name: "1.m4s" },
            { track_alias: 4, track_name: "2.m4s" },
        ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, 120_000);
