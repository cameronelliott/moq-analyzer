// Proves the loader keeps both halves of every object exchange, and that the two
// halves join into a latency leg.
//   bun test direction
//
// moq-rs logs an object twice: `_created` where it was built for the wire,
// `_parsed` where it was decoded off it. Keeping only the parsed half left every
// sent timestamp unreachable in event_other, which is half of all three legs the
// analyzer charts. subgroup_stream.direction is what puts them back.
//
// The leg test below is the mechanism behind chart 1 in miniature: two traces,
// one object, joined on (track_namespace, track_name, group_id, subgroup_id,
// object_id) -- track_alias is per-connection and deliberately differs here,
// because it does not survive the hop.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = import.meta.dir;

// Both traces share a reference_time, so a leg is exactly the difference of the
// two `time` fields and the test can state the answer in milliseconds.
const REFERENCE_TIME = 1788560083342.7483;

const header = (vantage: "client" | "server") => ({
    qlog_version: "0.3",
    qlog_format: "JSON-SEQ",
    title: "direction-test",
    description: "MoQ Transport events",
    trace: {
        vantage_point: { type: vantage },
        common_fields: { reference_time: REFERENCE_TIME, time_format: "relative" },
        event_schemas: ["urn:ietf:params:qlog:events:moqt"],
    },
});

type Dir = "created" | "parsed";

const subgroupHeader = (dir: Dir, time: number, stream: number, alias: number, group: number) => ({
    time,
    name: `moqt:subgroup_header_${dir}`,
    data: {
        event_type: `subgroup_header_${dir}`,
        stream_id: stream,
        header_type: "SubgroupIdExt",
        track_alias: alias,
        group_id: group,
        publisher_priority: 0,
        subgroup_id: 0,
    },
});

const object = (dir: Dir, time: number, stream: number, group: number, objectId: number) => ({
    time,
    name: `moqt:subgroup_object_${dir}`,
    data: {
        event_type: `subgroup_object_${dir}`,
        stream_id: stream,
        group_id: group,
        subgroup_id: 0,
        object_id: objectId,
        extension_headers: [],
        object_payload_length: 1271,
    },
});

/** subscribe + subscribe_ok, the pair the loader derives `track` from. */
const subscribe = (time: number, id: number, ns: string, name: string) => ({
    time,
    name: "moqt:control_message_parsed",
    data: {
        event_type: "control_message_parsed",
        stream_id: 0,
        message_type: "subscribe",
        subscribe_id: id,
        track_namespace: ns,
        track_name: name,
        parameters: [],
    },
});

const subscribeOk = (time: number, id: number, alias: number) => ({
    time,
    name: "moqt:control_message_parsed",
    data: {
        event_type: "control_message_parsed",
        stream_id: 0,
        message_type: "subscribe_ok",
        subscribe_id: id,
        track_alias: alias,
        parameters: [],
    },
});

function writeLog(dir: string, name: string, head: unknown, events: unknown[]) {
    const log = join(dir, name);
    writeFileSync(log, [head, ...events].map((o) => JSON.stringify(o)).join("\n") + "\n");
    return log;
}

/** Load one or more logs into one database. Returns the db path and the outcome. */
function loadInto(db: string, logs: string[]) {
    let last = { ok: true, stderr: "" };
    for (const log of logs) {
        const r = Bun.spawnSync([
            "duckdb", db,
            "-f", join(REPO, "schema.sql"),
            "-c", `set variable src='${log}';`,
            "-f", join(REPO, "load_file.sql"),
            "-f", join(REPO, "load_common.sql"),
        ]);
        last = { ok: r.exitCode === 0, stderr: r.stderr.toString() };
        if (!last.ok) break;
    }
    return last;
}

function query<T>(db: string, sql: string): T[] {
    const r = Bun.spawnSync(["duckdb", "-json", db, "-c", sql]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    const out = r.stdout.toString().trim();
    // duckdb -json emits a JSON array; the row shape is fixed by the caller's query
    return out === "" ? [] : (JSON.parse(out) as T[]);
}

function tmp(prefix: string) {
    return mkdtempSync(join(tmpdir(), prefix));
}

test("both directions land, and an object reaches its direction through the stream", () => {
    const dir = tmp("mlog-dir-");
    try {
        // real QUIC unidirectional ids: client-initiated 2 mod 4, server-initiated 3 mod 4
        const log = writeLog(dir, "both.jsonl", header("server"), [
            subgroupHeader("parsed", 1, 2, 0, 7),
            object("parsed", 2, 2, 7, 0),
            object("parsed", 3, 2, 7, 1),
            subgroupHeader("created", 4, 3, 0, 7),
            object("created", 5, 3, 7, 0),
        ]);
        const db = join(dir, "both.db");
        expect(loadInto(db, [log]).ok).toBe(true);

        // nothing fell through to the unrecognised-event table
        expect(query<{ n: number }>(db, "select count(*) as n from event_other")[0]!.n).toBe(0);

        expect(query<{ direction: string; n: number }>(db,
            "select direction, count(*)::int as n from object group by 1 order by 1"))
            .toEqual([{ direction: "created", n: 1 }, { direction: "parsed", n: 2 }]);

        // the stream carries it; the object inherits it through stream_id
        expect(query<{ stream_id: number; direction: string }>(db,
            "select stream_id, direction from subgroup_stream order by stream_id"))
            .toEqual([{ stream_id: 2, direction: "parsed" }, { stream_id: 3, direction: "created" }]);

        // and the event view names each event by its real direction
        expect(query<{ name: string; n: number }>(db,
            `select name, count(*)::int as n from event
             where name like 'subgroup%' group by 1 order by 1`))
            .toEqual([
                { name: "subgroup_header_created", n: 1 },
                { name: "subgroup_header_parsed", n: 1 },
                { name: "subgroup_object_created", n: 1 },
                { name: "subgroup_object_parsed", n: 2 },
            ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("one stream_id in both directions is refused, by name", () => {
    const dir = tmp("mlog-dir-collide-");
    try {
        // three headers over two distinct ids, so the stock-capture guard stays
        // quiet and only the direction guard can refuse this
        const log = writeLog(dir, "collide.jsonl", header("server"), [
            subgroupHeader("created", 1, 2, 0, 7),
            subgroupHeader("created", 2, 6, 0, 8),
            subgroupHeader("parsed", 3, 2, 0, 9),
        ]);
        const db = join(dir, "collide.db");
        const r = loadInto(db, [log]);

        expect(r.ok).toBe(false);
        expect(r.stderr).toContain("unsupported capture");
        expect(r.stderr).toContain("both a sent and a received subgroup header");

        // and it must not half-commit
        expect(query<{ n: number }>(db, "select count(*) as n from subgroup_stream")[0]!.n).toBe(0);
        expect(query<{ n: number }>(db, "select count(*) as n from trace")[0]!.n).toBe(0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the same object in two traces joins into a latency leg", () => {
    const dir = tmp("mlog-dir-leg-");
    try {
        // Sender: builds object 0 of group 7 at t=10ms, on its own track_alias 5.
        const sender = writeLog(dir, "sender.jsonl", header("client"), [
            subscribe(1, 5, "/bbb", "1.m4s"),
            subscribeOk(2, 5, 5),
            subgroupHeader("created", 9, 2, 5, 7),
            object("created", 10, 2, 7, 0),
        ]);
        // Receiver: decodes the same object at t=60ms, under a different alias.
        const receiver = writeLog(dir, "receiver.jsonl", header("server"), [
            subscribe(1, 4, "/bbb", "1.m4s"),
            subscribeOk(2, 4, 4),
            subgroupHeader("parsed", 59, 2, 4, 7),
            object("parsed", 60, 2, 7, 0),
        ]);

        const db = join(dir, "leg.db");
        expect(loadInto(db, [sender, receiver]).ok).toBe(true);

        // two files, two generated ids, no caller bookkeeping
        expect(query<{ trace_id: number; vantage_point: string }>(db,
            "select trace_id, vantage_point from trace order by trace_id"))
            .toEqual([
                { trace_id: 1, vantage_point: "client" },
                { trace_id: 2, vantage_point: "server" },
            ]);

        // the aliases really do differ, which is why the join cannot use them
        expect(query<{ track_alias: number }>(db,
            "select distinct track_alias from object order by 1"))
            .toEqual([{ track_alias: 4 }, { track_alias: 5 }]);

        const legs = query<{ track_name: string; ms: number }>(db, `
            select s.track_name,
                   datediff('microsecond', s.wall_time, r.wall_time)/1000.0 as ms
            from object s
            join object r
              on (r.track_namespace, r.track_name, r.group_id, r.subgroup_id, r.object_id)
               = (s.track_namespace, s.track_name, s.group_id, s.subgroup_id, s.object_id)
             and r.direction = 'parsed'
            where s.direction = 'created'`);

        expect(legs).toEqual([{ track_name: "1.m4s", ms: 50 }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loading one file twice into one database is refused", () => {
    const dir = tmp("mlog-dir-dup-");
    try {
        const log = writeLog(dir, "once.jsonl", header("server"), [
            subgroupHeader("parsed", 1, 2, 0, 7),
            object("parsed", 2, 2, 7, 0),
            subgroupHeader("parsed", 3, 6, 0, 8),
        ]);
        const db = join(dir, "dup.db");
        expect(loadInto(db, [log]).ok).toBe(true);

        const again = loadInto(db, [log]);
        expect(again.ok).toBe(false);
        expect(again.stderr).toContain("filename");

        // the first load is intact; the second added nothing
        expect(query<{ n: number }>(db, "select count(*) as n from trace")[0]!.n).toBe(1);
        expect(query<{ n: number }>(db, "select count(*) as n from subgroup_object")[0]!.n).toBe(1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
