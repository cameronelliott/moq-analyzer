// Proves the loader refuses a capture it cannot chart honestly, and leaves
// nothing behind when it does.
//   bun test
//
// Two guards, one fixture each way:
//   * trace.reference_time is NOT NULL (schema.sql) -- no wall clock, no chart.
//   * load_common.sql errors when every subgroup header shares one stream_id --
//     the stock-moq-rs signature; objects cannot reach a group without it.
//
// fixtures/vanilla-stock.mlog is the first 12 lines of a stock moq-rs relay's
// server mlog (a1/data/vanilla), verbatim: no common_fields in the header, and
// stream_id 0 on every event. It is the real thing the guards exist for.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = import.meta.dir;
const VANILLA = join(REPO, "fixtures", "vanilla-stock.mlog");

const header = (withReferenceTime: boolean) => ({
    qlog_version: "0.3",
    qlog_format: "JSON-SEQ",
    title: "guards-test",
    description: "MoQ Transport events",
    trace: {
        vantage_point: { type: "client" },
        ...(withReferenceTime
            ? { common_fields: { reference_time: 1788560083342.7483, time_format: "relative" } }
            : {}),
        event_schemas: ["urn:ietf:params:qlog:events:moqt"],
    },
});

const subgroupHeader = (time: number, stream: number, group: number) => ({
    time,
    name: "moqt:subgroup_header_parsed",
    data: {
        event_type: "subgroup_header_parsed",
        stream_id: stream,
        header_type: "SubgroupIdExt",
        track_alias: 0,
        group_id: group,
        publisher_priority: 0,
        subgroup_id: 0,
    },
});

const object = (time: number, stream: number, objectId: number) => ({
    time,
    name: "moqt:subgroup_object_parsed",
    data: {
        event_type: "subgroup_object_parsed",
        stream_id: stream,
        group_id: 0,
        subgroup_id: 0,
        object_id: objectId,
        extension_headers: [],
        object_payload_length: 1271,
    },
});

const TABLES = ["trace", "control_message", "subgroup_stream", "subgroup_object", "event_other", "shape"];

/** Load one mlog file through the real CLI; report the outcome and what landed. */
function load(log: string) {
    const dir = mkdtempSync(join(tmpdir(), "mlog-guards-"));
    try {
        const db = join(dir, "fixture.db");
        const r = Bun.spawnSync([
            "duckdb", db,
            "-f", join(REPO, "schema.sql"),
            "-c", `set variable src='${log}';`,
            "-f", join(REPO, "load_file.sql"),
            "-f", join(REPO, "load_common.sql"),
        ]);
        const counts: Record<string, number> = {};
        for (const t of TABLES) {
            const q = Bun.spawnSync(["duckdb", "-json", db, "-c", `select count(*) as n from ${t}`]);
            if (q.exitCode !== 0) throw new Error(q.stderr.toString());
            // duckdb -json prints [{"n":N}]; the shape is fixed by the query above
            counts[t] = (JSON.parse(q.stdout.toString()) as { n: number }[])[0]!.n;
        }
        return { ok: r.exitCode === 0, stderr: r.stderr.toString(), counts };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** Write a synthetic trace and load it. */
function loadEvents(head: unknown, events: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), "mlog-guards-src-"));
    try {
        const log = join(dir, "fixture.jsonl");
        writeFileSync(log, [head, ...events].map((o) => JSON.stringify(o)).join("\n") + "\n");
        return load(log);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const nothingLanded = (counts: Record<string, number>) =>
    expect(counts).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));

test("the stock moq-rs capture in fixtures/ is refused, by name", () => {
    const r = load(VANILLA);

    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("unsupported capture");
    expect(r.stderr).toContain("stream_id");
    nothingLanded(r.counts);
});

test("subgroup headers that all share one stream_id are refused", () => {
    const r = loadEvents(header(true), [
        subgroupHeader(1, 0, 0),
        object(2, 0, 0),
        subgroupHeader(3, 0, 1),
        object(4, 0, 0),
    ]);

    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("unsupported capture");
    nothingLanded(r.counts);
});

test("one subgroup header is not evidence of a stock capture", () => {
    // a single header has exactly one distinct stream_id by definition
    const r = loadEvents(header(true), [subgroupHeader(1, 0, 0), object(2, 0, 0)]);

    expect(r.stderr).toBe("");
    expect(r.ok).toBe(true);
    expect(r.counts.subgroup_stream).toBe(1);
    expect(r.counts.subgroup_object).toBe(1);
});

test("a row cannot land under no trace at all", () => {
    // getvariable() returns NULL for a name the connection never saw, so a
    // statement run without its SET VARIABLE used to write orphans in silence.
    // Barely reachable under `duckdb -f`; ordinary once these scripts are driven
    // statement-by-statement from duckdb-wasm.
    const dir = mkdtempSync(join(tmpdir(), "mlog-orphan-"));
    try {
        const db = join(dir, "orphan.db");
        for (const insert of [
            "INSERT INTO subgroup_object VALUES (getvariable('trace_id')::USMALLINT, 2, 0, 100, 1271, 0)",
            "INSERT INTO event_other VALUES (getvariable('trace_id')::USMALLINT, 100, 'x', '{}')",
        ]) {
            const r = Bun.spawnSync([
                "duckdb", db, "-f", join(REPO, "schema.sql"), "-c", insert,
            ]);
            expect(r.exitCode).not.toBe(0);
            expect(r.stderr.toString()).toContain("NOT NULL constraint failed");
        }

        const q = Bun.spawnSync(["duckdb", "-json", db, "-c",
            "select count(*) as n from subgroup_object"]);
        // duckdb -json prints [{"n":N}]; the shape is fixed by the query above
        expect((JSON.parse(q.stdout.toString()) as { n: number }[])[0]!.n).toBe(0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a header without reference_time is refused", () => {
    // real stream ids, so only the missing clock can refuse this one
    const r = loadEvents(header(false), [
        subgroupHeader(1, 4, 0),
        object(2, 4, 0),
        subgroupHeader(3, 8, 1),
        object(4, 8, 0),
    ]);

    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("NOT NULL constraint failed: trace.reference_time");
    nothingLanded(r.counts);
});
