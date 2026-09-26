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

const header = (vantage: "client" | "server", referenceTime = REFERENCE_TIME) => ({
    qlog_version: "0.3",
    qlog_format: "JSON-SEQ",
    title: "direction-test",
    description: "MoQ Transport events",
    trace: {
        vantage_point: { type: vantage },
        common_fields: { reference_time: referenceTime, time_format: "relative" },
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

const object = (dir: Dir, time: number, stream: number, group: number, objectId: number,
                payloadLength = 1271) => ({
    time,
    name: `moqt:subgroup_object_${dir}`,
    data: {
        event_type: `subgroup_object_${dir}`,
        stream_id: stream,
        group_id: group,
        subgroup_id: 0,
        object_id: objectId,
        extension_headers: [],
        object_payload_length: payloadLength,
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

/** A relay's own subscribe_ok, which it *created* on an outbound connection.
 *  Its time is what decides whether an object was already held. */
const subscribeOkCreated = (time: number, id: number, alias: number) => ({
    time,
    name: "moqt:control_message_created",
    data: {
        event_type: "control_message_created",
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

/** Load one or more logs into one database. A cid pairs two ends of a connection. */
function loadInto(db: string, logs: (string | { log: string; cid: string })[]) {
    let last = { ok: true, stderr: "" };
    for (const entry of logs) {
        const { log, cid } = typeof entry === "string" ? { log: entry, cid: undefined } : entry;
        const r = Bun.spawnSync([
            "duckdb", db,
            "-f", join(REPO, "schema.sql"),
            "-c", `set variable src='${log}';`
                + (cid === undefined ? "" : ` set variable cid='${cid}';`),
            "-f", join(REPO, "load.sql"),
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
        expect(loadInto(db, [
            { log: sender, cid: "conn-1" },
            { log: receiver, cid: "conn-1" },
        ]).ok).toBe(true);

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

        // and the `hop` view is that join, written once so nobody re-derives it
        expect(query<{ cid: string; track_name: string; us: number; n: number }>(db, `
            select cid, track_name, us::int as us, count(*)::int as n
            from hop group by 1,2,3`))
            .toEqual([{ cid: "conn-1", track_name: "1.m4s", us: 50_000, n: 1 }]);

        // it names both ends, so a leg can be attributed to a vantage point
        expect(query<{ send_trace: number; recv_trace: number }>(db,
            "select send_trace, recv_trace from hop"))
            .toEqual([{ send_trace: 1, recv_trace: 2 }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("hop needs a cid, and never matches a trace against itself", () => {
    const dir = tmp("mlog-hop-nocid-");
    try {
        // the same exchange as above, but no cid supplied at load
        const sender = writeLog(dir, "s.jsonl", header("client"), [
            subscribe(1, 5, "/bbb", "1.m4s"), subscribeOk(2, 5, 5),
            subgroupHeader("created", 9, 2, 5, 7), object("created", 10, 2, 7, 0),
        ]);
        const receiver = writeLog(dir, "r.jsonl", header("server"), [
            subscribe(1, 4, "/bbb", "1.m4s"), subscribeOk(2, 4, 4),
            subgroupHeader("parsed", 59, 2, 4, 7), object("parsed", 60, 2, 7, 0),
        ]);
        const db = join(dir, "nocid.db");
        expect(loadInto(db, [sender, receiver]).ok).toBe(true);

        // both objects landed, but nothing ties the two traces to one connection
        expect(query<{ n: number }>(db, "select count(*) as n from object")[0]!.n).toBe(2);
        expect(query<{ n: number }>(db, "select count(*) as n from hop")[0]!.n).toBe(0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("one trace carrying both directions produces no hop with itself", () => {
    const dir = tmp("mlog-hop-self-");
    try {
        // a relay end that both receives and forwards the same object id
        const log = writeLog(dir, "self.jsonl", header("server"), [
            subscribe(1, 4, "/bbb", "1.m4s"), subscribeOk(2, 4, 4),
            subgroupHeader("parsed", 10, 2, 4, 7), object("parsed", 11, 2, 7, 0),
            subgroupHeader("created", 12, 3, 4, 7), object("created", 13, 3, 7, 0),
        ]);
        const db = join(dir, "self.db");
        expect(loadInto(db, [{ log, cid: "conn-1" }]).ok).toBe(true);

        expect(query<{ n: number }>(db, "select count(*) as n from object")[0]!.n).toBe(2);
        // a hop crosses a connection; one endpoint's own two sides are not one
        expect(query<{ n: number }>(db, "select count(*) as n from hop")[0]!.n).toBe(0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("dwell is the relay's own two sides, across two connections", () => {
    const dir = tmp("mlog-dwell-");
    try {
        // A whole path in miniature. The relay is two files, one per connection,
        // and only vantage_point says which end of each it is.
        const track = (id: number, alias: number) => [subscribe(1, id, "/bbb", "1.m4s"),
                                                      subscribeOk(2, id, alias)];
        const pub = writeLog(dir, "pub.jsonl", header("client"), [
            ...track(5, 5),
            subgroupHeader("created", 9, 2, 5, 7), object("created", 10, 2, 7, 0),
        ]);
        const relayIn = writeLog(dir, "relay-in.jsonl", header("server"), [
            ...track(4, 4),
            subgroupHeader("parsed", 59, 2, 4, 7), object("parsed", 60, 2, 7, 0),
        ]);
        const relayOut = writeLog(dir, "relay-out.jsonl", header("server"), [
            ...track(4, 4),
            subgroupHeader("created", 61, 3, 4, 7), object("created", 62, 3, 7, 0),
        ]);
        const sub = writeLog(dir, "sub.jsonl", header("client"), [
            ...track(4, 4),
            subgroupHeader("parsed", 99, 3, 4, 7), object("parsed", 100, 3, 7, 0),
        ]);

        const db = join(dir, "path.db");
        expect(loadInto(db, [
            { log: pub, cid: "c1" }, { log: relayIn, cid: "c1" },
            { log: relayOut, cid: "c2" }, { log: sub, cid: "c2" },
        ]).ok).toBe(true);

        // two hops: publisher to relay, relay to subscriber
        expect(query<{ cid: string; us: number }>(db,
            "select cid, us::int as us from hop order by cid"))
            .toEqual([{ cid: "c1", us: 50_000 }, { cid: "c2", us: 38_000 }]);

        // and the relay's own transit between them
        expect(query<{ in_cid: string; out_cid: string; us: number }>(db,
            "select in_cid, out_cid, us::int as us from dwell"))
            .toEqual([{ in_cid: "c1", out_cid: "c2", us: 2_000 }]);

        // the three legs account for the whole path, with nothing left over
        expect(query<{ total: number }>(db, `
            select ((select us from hop where cid='c1')
                  + (select us from dwell)
                  + (select us from hop where cid='c2'))::int as total`))
            .toEqual([{ total: 90_000 }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("leg gives three rows per object, and the means account for the path", () => {
    const dir = tmp("mlog-leg-");
    try {
        const track = (id: number, alias: number) => [subscribe(1, id, "/bbb", "1.m4s"),
                                                      subscribeOk(2, id, alias)];
        // pub sends at 10, relay receives 60, forwards 62, sub receives 100
        const pub = writeLog(dir, "pub.jsonl", header("client"), [
            ...track(5, 5),
            subgroupHeader("created", 9, 2, 5, 7), object("created", 10, 2, 7, 0),
        ]);
        const relayIn = writeLog(dir, "relay-in.jsonl", header("server"), [
            ...track(4, 4),
            subgroupHeader("parsed", 59, 2, 4, 7), object("parsed", 60, 2, 7, 0),
        ]);
        const relayOut = writeLog(dir, "relay-out.jsonl", header("server"), [
            ...track(4, 4),
            subgroupHeader("created", 61, 3, 4, 7), object("created", 62, 3, 7, 0),
        ]);
        const sub = writeLog(dir, "sub.jsonl", header("client"), [
            ...track(4, 4),
            subgroupHeader("parsed", 99, 3, 4, 7), object("parsed", 100, 3, 7, 0),
        ]);

        const db = join(dir, "leg.db");
        expect(loadInto(db, [
            { log: pub, cid: "c1" }, { log: relayIn, cid: "c1" },
            { log: relayOut, cid: "c2" }, { log: sub, cid: "c2" },
        ]).ok).toBe(true);

        expect(query<{ leg_no: number; leg: string; us: number }>(db,
            "select leg_no, leg, us::int as us from leg order by leg_no"))
            .toEqual([
                { leg_no: 1, leg: "pub -> relay", us: 50_000 },
                { leg_no: 2, leg: "relay dwell", us: 2_000 },
                { leg_no: 3, leg: "relay -> sub", us: 38_000 },
            ]);

        // the three legs account for the whole path, which is what lets a
        // composition bar be built from means
        expect(query<{ total: number }>(db,
            "select sum(us)::int as total from leg")).toEqual([{ total: 90_000 }]);

        // every leg is attributed to the subscriber whose path it belongs to,
        // including leg 1, which is a connection they all share
        expect(query<{ sub_cid: string; n: number }>(db,
            "select sub_cid, count(*)::int as n from leg group by 1"))
            .toEqual([{ sub_cid: "c2", n: 3 }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an object the relay held before subscribe_ok is flagged, and left out of leg", () => {
    const dir = tmp("mlog-held-");
    try {
        // Two objects. The relay receives A at 50 and B at 100, and accepts this
        // subscriber's subscription at 70 -- so A was already sitting there and
        // B was not. A's dwell measures the subscriber showing up, not the relay.
        const pub = writeLog(dir, "pub.jsonl", header("client"), [
            subscribe(1, 5, "/bbb", "1.m4s"), subscribeOk(2, 5, 5),
            subgroupHeader("created", 9, 2, 5, 7),
            object("created", 10, 2, 7, 0),
            object("created", 60, 2, 7, 1),
        ]);
        const relayIn = writeLog(dir, "relay-in.jsonl", header("server"), [
            subscribe(1, 4, "/bbb", "1.m4s"), subscribeOk(2, 4, 4),
            subgroupHeader("parsed", 49, 2, 4, 7),
            object("parsed", 50, 2, 7, 0),
            object("parsed", 100, 2, 7, 1),
        ]);
        const relayOut = writeLog(dir, "relay-out.jsonl", header("server"), [
            subscribe(1, 4, "/bbb", "1.m4s"),
            subscribeOkCreated(70, 4, 4),          // the moment that decides it
            subgroupHeader("created", 79, 3, 4, 7),
            object("created", 80, 3, 7, 0),
            object("created", 110, 3, 7, 1),
        ]);
        const sub = writeLog(dir, "sub.jsonl", header("client"), [
            subscribe(1, 4, "/bbb", "1.m4s"), subscribeOk(2, 4, 4),
            subgroupHeader("parsed", 119, 3, 4, 7),
            object("parsed", 120, 3, 7, 0),
            object("parsed", 150, 3, 7, 1),
        ]);

        const db = join(dir, "held.db");
        expect(loadInto(db, [
            { log: pub, cid: "c1" }, { log: relayIn, cid: "c1" },
            { log: relayOut, cid: "c2" }, { log: sub, cid: "c2" },
        ]).ok).toBe(true);

        // dwell keeps both and says which is which
        expect(query<{ object_id: number; held: boolean; us: number }>(db,
            "select object_id, held, us::int as us from dwell order by object_id"))
            .toEqual([
                { object_id: 0, held: true, us: 30_000 },
                { object_id: 1, held: false, us: 10_000 },
            ]);

        // leg drops the held object whole -- all three of its legs, not just dwell
        expect(query<{ object_id: number; n: number }>(db,
            "select object_id, count(*)::int as n from leg group by 1 order by 1"))
            .toEqual([{ object_id: 1, n: 3 }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("interarrival measures one track at one endpoint, and object_bitrate buckets it", () => {
    const dir = tmp("mlog-charts23-");
    try {
        // Two tracks, interleaved on purpose. 1.m4s arrives at 60 and 100,
        // 2.m4s at 70 and 80, so the per-track gaps are 40 and 10. A lag that
        // forgot to partition would see 60,70,80,100 and answer 10,10,20 --
        // which is why one track in the fixture would prove nothing.
        const sender = writeLog(dir, "s.jsonl", header("client"), [
            subscribe(1, 5, "/bbb", "1.m4s"), subscribeOk(2, 5, 5),
            subscribe(3, 7, "/bbb", "2.m4s"), subscribeOk(4, 7, 7),
            subgroupHeader("created", 9, 2, 5, 7),
            subgroupHeader("created", 9, 6, 7, 7),
            object("created", 10, 2, 7, 0), object("created", 20, 6, 7, 0),
            object("created", 30, 6, 7, 1), object("created", 40, 2, 7, 1),
        ]);
        const receiver = writeLog(dir, "r.jsonl", header("server"), [
            subscribe(1, 4, "/bbb", "1.m4s"), subscribeOk(2, 4, 4),
            subscribe(3, 6, "/bbb", "2.m4s"), subscribeOk(4, 6, 6),
            subgroupHeader("parsed", 59, 2, 4, 7),
            subgroupHeader("parsed", 59, 6, 6, 7),
            object("parsed", 60, 2, 7, 0), object("parsed", 70, 6, 7, 0),
            object("parsed", 80, 6, 7, 1), object("parsed", 100, 2, 7, 1),
        ]);
        const db = join(dir, "charts.db");
        expect(loadInto(db, [
            { log: sender, cid: "c1" }, { log: receiver, cid: "c1" },
        ]).ok).toBe(true);

        // the first object of each track has no predecessor: NULL, not zero
        expect(query<{ track_name: string; object_id: number; us: number | null }>(db,
            `select track_name, object_id, us::int as us
             from interarrival order by track_name, object_id`))
            .toEqual([
                { track_name: "1.m4s", object_id: 0, us: null },
                { track_name: "1.m4s", object_id: 1, us: 40_000 },
                { track_name: "2.m4s", object_id: 0, us: null },
                { track_name: "2.m4s", object_id: 1, us: 10_000 },
            ]);

        // object_bitrate buckets per track and direction: two objects of 1271
        // bytes each, both tracks inside the same second, sent and received
        expect(query<{ direction: string; track_name: string; objects: number;
                       bytes: number; bits: number }>(db,
            `select direction::varchar as direction, track_name, objects::int as objects,
                    bytes::int as bytes, bits::int as bits
             from object_bitrate order by direction, track_name`))
            .toEqual([
                { direction: "created", track_name: "1.m4s", objects: 2, bytes: 2542, bits: 20_336 },
                { direction: "created", track_name: "2.m4s", objects: 2, bytes: 2542, bits: 20_336 },
                { direction: "parsed",  track_name: "1.m4s", objects: 2, bytes: 2542, bits: 20_336 },
                { direction: "parsed",  track_name: "2.m4s", objects: 2, bytes: 2542, bits: 20_336 },
            ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Two tracks, interleaved, over pub -> relay -> sub. Per object, in ms:
 *
 *   track obj  pub  relay-in  relay-out  sub  | leg1 dwell leg3
 *   1.m4s  0    10     60        61      100  |  50    1    39
 *   2.m4s  0    15     65        66      105  |  50    1    39
 *   1.m4s  1    20     72        74      115  |  52    2    41
 *   2.m4s  1    25     76        77      117  |  51    1    40
 *   1.m4s  2    30     79        80      120  |  49    1    40
 *
 * D between consecutive arrivals on one track is the change in transit.
 * A lag that forgot the track would pair 1.m4s with 2.m4s and answer
 * 0, 2, 1, 2 for leg 1 instead of 2, -3 and 1.
 *
 * The subscriber's clock runs a whole second ahead. Leg 3 transit is then
 * wrong by that second, and D must not notice: both transits carry it. It
 * also puts leg 3's arrivals in the second after legs 1 and 2's.
 *
 * Sizes differ per object, 1.m4s object 0 standing in for a keyframe, so a
 * row that picked up another object's size shows up.
 */
function twoTrackPath(dir: string) {
    const size1 = [40_000, 1_200, 1_300];
    const size2 = [500, 600];
    const hdrs = (alias: number) => [
        subscribe(1, alias, "/bbb", "1.m4s"), subscribeOk(2, alias, alias),
        subscribe(3, alias + 1, "/bbb", "2.m4s"), subscribeOk(4, alias + 1, alias + 1),
    ];
    const side = (dir: Dir, s1: number, s2: number, alias: number,
                  t1: number[], t2: number[]) => {
        type Obj = [number, number, number, number];
        const objs: Obj[] = [
            ...t1.map((t, i): Obj => [t, s1, i, size1[i]!]),
            ...t2.map((t, i): Obj => [t, s2, i, size2[i]!]),
        ].sort((a, b) => a[0] - b[0]);
        return [
            ...hdrs(alias),
            subgroupHeader(dir, 5, s1, alias, 7),
            subgroupHeader(dir, 5, s2, alias + 1, 7),
            ...objs.map(([t, s, id, len]) => object(dir, t, s, 7, id, len)),
        ];
    };
    const pub = writeLog(dir, "pub.jsonl", header("client"),
        side("created", 2, 6, 5, [10, 20, 30], [15, 25]));
    const relayIn = writeLog(dir, "relay-in.jsonl", header("server"),
        side("parsed", 2, 6, 4, [60, 72, 79], [65, 76]));
    const relayOut = writeLog(dir, "relay-out.jsonl", header("server"),
        side("created", 3, 7, 4, [61, 74, 80], [66, 77]));
    const sub = writeLog(dir, "sub.jsonl", header("client", REFERENCE_TIME + 1000),
        side("parsed", 3, 7, 4, [100, 115, 120], [105, 117]));

    const db = join(dir, "path.db");
    const r = loadInto(db, [
        { log: pub, cid: "c1" }, { log: relayIn, cid: "c1" },
        { log: relayOut, cid: "c2" }, { log: sub, cid: "c2" },
    ]);
    return { db, ok: r.ok };
}

test("jitter is RFC 3550's D per leg and track, and a clock offset cancels out", () => {
    const dir = tmp("mlog-jitter-");
    try {
        const { db, ok } = twoTrackPath(dir);
        expect(ok).toBe(true);

        // the offset really is there: leg 3 transit is off by a full second
        expect(query<{ us: number }>(db,
            "select us::int as us from leg where leg_no = 3 and track_name = '1.m4s' and object_id = 0"))
            .toEqual([{ us: 1_039_000 }]);

        // first object per track has no predecessor, so NULL rather than zero
        expect(query<{ leg_no: number; track_name: string; object_id: number;
                       d_us: number | null; jitter_us: number | null }>(db,
            `select leg_no, track_name, object_id, d_us::int as d_us, jitter_us::int as jitter_us
             from jitter order by leg_no, track_name, object_id`))
            .toEqual([
                { leg_no: 1, track_name: "1.m4s", object_id: 0, d_us: null,   jitter_us: null },
                { leg_no: 1, track_name: "1.m4s", object_id: 1, d_us: 2000,  jitter_us: 2000 },
                { leg_no: 1, track_name: "1.m4s", object_id: 2, d_us: -3000, jitter_us: 3000 },
                { leg_no: 1, track_name: "2.m4s", object_id: 0, d_us: null,   jitter_us: null },
                { leg_no: 1, track_name: "2.m4s", object_id: 1, d_us: 1000,  jitter_us: 1000 },
                { leg_no: 2, track_name: "1.m4s", object_id: 0, d_us: null,   jitter_us: null },
                { leg_no: 2, track_name: "1.m4s", object_id: 1, d_us: 1000,  jitter_us: 1000 },
                { leg_no: 2, track_name: "1.m4s", object_id: 2, d_us: -1000, jitter_us: 1000 },
                { leg_no: 2, track_name: "2.m4s", object_id: 0, d_us: null,   jitter_us: null },
                { leg_no: 2, track_name: "2.m4s", object_id: 1, d_us: 0,     jitter_us: 0 },
                { leg_no: 3, track_name: "1.m4s", object_id: 0, d_us: null,   jitter_us: null },
                { leg_no: 3, track_name: "1.m4s", object_id: 1, d_us: 2000,  jitter_us: 2000 },
                { leg_no: 3, track_name: "1.m4s", object_id: 2, d_us: -1000, jitter_us: 1000 },
                { leg_no: 3, track_name: "2.m4s", object_id: 0, d_us: null,   jitter_us: null },
                { leg_no: 3, track_name: "2.m4s", object_id: 1, d_us: 1000,  jitter_us: 1000 },
            ]);

        // every row belongs to the one subscriber, including leg 1's shared hop
        expect(query<{ sub_cid: string; n: number }>(db,
            "select sub_cid, count(*)::int as n from jitter group by 1"))
            .toEqual([{ sub_cid: "c2", n: 15 }]);

        // each object's size rides along on all three of its legs, so a chart can
        // split keyframes from the rest
        expect(query<{ track_name: string; object_id: number; payload_length: number; legs: number }>(db,
            `select track_name, object_id, payload_length::int as payload_length,
                    count(*)::int as legs
             from jitter group by all order by track_name, object_id`))
            .toEqual([
                { track_name: "1.m4s", object_id: 0, payload_length: 40_000, legs: 3 },
                { track_name: "1.m4s", object_id: 1, payload_length: 1_200,  legs: 3 },
                { track_name: "1.m4s", object_id: 2, payload_length: 1_300,  legs: 3 },
                { track_name: "2.m4s", object_id: 0, payload_length: 500,    legs: 3 },
                { track_name: "2.m4s", object_id: 1, payload_length: 600,    legs: 3 },
            ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the frame views summarize leg and jitter per subscriber and leg", () => {
    const dir = tmp("mlog-frames-");
    try {
        const { db, ok } = twoTrackPath(dir);
        expect(ok).toBe(true);

        // Both tracks together, per leg. Leg 3 carries the subscriber's
        // one-second clock offset. p95 interpolates: of five sorted values it
        // sits 0.8 of the way from the fourth to the fifth.
        expect(query<{ sub_cid: string; leg_no: number; leg: string; n: number;
                       mean_ms: number; median_ms: number; p95_ms: number }>(db,
            `select sub_cid, leg_no, leg, n::int as n, round(mean_ms, 3) as mean_ms,
                    round(median_ms, 3) as median_ms, round(p95_ms, 3) as p95_ms
             from leg_summary order by leg_no`))
            .toEqual([
                { sub_cid: "c2", leg_no: 1, leg: "pub -> relay", n: 5,
                  mean_ms: 50.4, median_ms: 50, p95_ms: 51.8 },
                { sub_cid: "c2", leg_no: 2, leg: "relay dwell", n: 5,
                  mean_ms: 1.2, median_ms: 1, p95_ms: 1.8 },
                { sub_cid: "c2", leg_no: 3, leg: "relay -> sub", n: 5,
                  mean_ms: 1039.8, median_ms: 1040, p95_ms: 1040.8 },
            ]);

        // |D| samples per leg, first objects excluded: leg 1 is 2, 3 and 1 ms,
        // leg 2 is 1, 1 and 0, leg 3 is 2, 1 and 1.
        expect(query<{ leg_no: number; n: number; mean_ms: number; p95_ms: number;
                       p99_ms: number; max_ms: number }>(db,
            `select leg_no, n::int as n, round(mean_ms, 3) as mean_ms,
                    round(p95_ms, 3) as p95_ms, round(p99_ms, 3) as p99_ms,
                    round(max_ms, 3) as max_ms
             from jitter_summary order by leg_no`))
            .toEqual([
                { leg_no: 1, n: 3, mean_ms: 2,     p95_ms: 2.9, p99_ms: 2.98, max_ms: 3 },
                { leg_no: 2, n: 3, mean_ms: 0.667, p95_ms: 1,   p99_ms: 1,    max_ms: 1 },
                { leg_no: 3, n: 3, mean_ms: 1.333, p95_ms: 1.9, p99_ms: 1.98, max_ms: 2 },
            ]);

        // One row per leg and second. t_s counts from the capture's first
        // sample, so leg 3, read on a clock a second ahead, lands at 1.
        expect(query<{ leg_no: number; t_s: number; n: number; mean_ms: number; max_ms: number }>(db,
            `select leg_no, t_s::int as t_s, n::int as n,
                    round(mean_ms, 3) as mean_ms, round(max_ms, 3) as max_ms
             from jitter_series order by leg_no, t_s`))
            .toEqual([
                { leg_no: 1, t_s: 0, n: 3, mean_ms: 2,     max_ms: 3 },
                { leg_no: 2, t_s: 0, n: 3, mean_ms: 0.667, max_ms: 1 },
                { leg_no: 3, t_s: 1, n: 3, mean_ms: 1.333, max_ms: 2 },
            ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * One connection, two tracks, five seconds. The sender builds each object at
 * the ms below and the receiver decodes it 50 ms later, in the same second.
 * The reference time sits .343 s into its second, so ms 1000k+10 to 1000k+160
 * all land in second k.
 *
 *   second   1.m4s              2.m4s
 *     0      1000 B, 1000 B     100 B
 *     1      3000 B             100 B
 *     2      --                 100 B
 *     3      500 B, 500 B       100 B
 *     4      1000 B             100 B
 *     5      --                 100 B
 *
 * Second 2 has no 1.m4s object, so that track has a gap there. 1.m4s stops a
 * second before the log does, so its last second, 4, is a whole second.
 */
function bitratePair(dir: string) {
    const a: [number, number][] = [[10, 1000], [110, 1000], [1010, 3000], [3010, 500], [3110, 500], [4010, 1000]];
    const b: [number, number][] = [[60, 100], [1060, 100], [2060, 100], [3060, 100], [4060, 100], [5060, 100]];
    const side = (d: Dir, alias: number, s1: number, s2: number, shift: number) => {
        const objs = [
            ...a.map(([t, len], i) => ({ t: t + shift, s: s1, id: i, len })),
            ...b.map(([t, len], i) => ({ t: t + shift, s: s2, id: i, len })),
        ].sort((x, y) => x.t - y.t);
        return [
            subscribe(1, alias, "/bbb", "1.m4s"), subscribeOk(2, alias, alias),
            subscribe(3, alias + 1, "/bbb", "2.m4s"), subscribeOk(4, alias + 1, alias + 1),
            subgroupHeader(d, 5 + shift, s1, alias, 7),
            subgroupHeader(d, 5 + shift, s2, alias + 1, 7),
            ...objs.map((o) => object(d, o.t, o.s, 7, o.id, o.len)),
        ];
    };
    const sender = writeLog(dir, "s.jsonl", header("client"), side("created", 5, 2, 6, 0));
    const receiver = writeLog(dir, "r.jsonl", header("server"), side("parsed", 4, 2, 6, 50));
    const db = join(dir, "bitrate.db");
    const r = loadInto(db, [{ log: sender, cid: "c1" }, { log: receiver, cid: "c1" }]);
    return { db, ok: r.ok };
}

test("object_bitrate frames: per track and all tracks, series and summary", () => {
    const dir = tmp("mlog-bitrate-");
    try {
        const { db, ok } = bitratePair(dir);
        expect(ok).toBe(true);

        // The sent side. `all` rows sum both tracks in each second; they are
        // their own rows, never a column beside the track rows. t_s counts
        // from the capture's first object.
        type S = { scope: string; track_name: string | null; t_s: number;
                   objects: number; bytes: number; kbit_s: number };
        const series = query<S>(db,
            `select scope, track_name, t_s::int as t_s, objects::int as objects,
                    bytes::int as bytes, round(kbit_s, 3) as kbit_s
             from object_bitrate_series where direction = 'created'
             order by scope desc, track_name, t_s`);
        const row = (scope: string, track_name: string | null, t_s: number,
                     objects: number, bytes: number): S =>
            ({ scope, track_name, t_s, objects, bytes, kbit_s: bytes * 8 / 1000 });
        expect(series).toEqual([
            row("track", "1.m4s", 0, 2, 2000), row("track", "1.m4s", 1, 1, 3000),
            row("track", "1.m4s", 3, 2, 1000), row("track", "1.m4s", 4, 1, 1000),
            row("track", "2.m4s", 0, 1, 100), row("track", "2.m4s", 1, 1, 100),
            row("track", "2.m4s", 2, 1, 100), row("track", "2.m4s", 3, 1, 100),
            row("track", "2.m4s", 4, 1, 100), row("track", "2.m4s", 5, 1, 100),
            row("all", null, 0, 3, 2100), row("all", null, 1, 2, 3100),
            row("all", null, 2, 1, 100), row("all", null, 3, 3, 1100),
            row("all", null, 4, 2, 1100), row("all", null, 5, 1, 100),
        ]);

        // the received side carries the same bytes, from the other end
        expect(query<{ direction: string; vantage_point: string; bytes: number }>(db,
            `select direction::varchar as direction, vantage_point, sum(bytes)::int as bytes
             from object_bitrate_series where scope = 'track' group by all order by 1`))
            .toEqual([
                { direction: "created", vantage_point: "client", bytes: 7600 },
                { direction: "parsed",  vantage_point: "server", bytes: 7600 },
            ]);

        // The summary drops the first and last second of each end's log, which
        // are partial -- the same seconds for every row of that end, so 1.m4s
        // keeps its whole last second, 4. span_s is the interior, gaps included;
        // the mean is bits over span_s, so a gap counts as zero and the track
        // means add up to the `all` mean. Percentiles are over seconds with data.
        //   1.m4s interior: 24, 8, 8 kbit/s over 4 s, one gap -> mean 10
        //   2.m4s interior: 0.8 four times
        //   all   interior: 24.8, 0.8, 8.8, 8.8 -> mean 10.8 = 10 + 0.8
        expect(query<{ scope: string; track_name: string | null; bytes: number;
                       seconds: number; span_s: number; mean: number; p5: number;
                       median: number; p95: number; max: number }>(db,
            `select scope, track_name, bytes::int as bytes, seconds::int as seconds,
                    span_s::int as span_s, round(mean_kbit_s, 3) as mean,
                    round(p5_kbit_s, 3) as p5, round(median_kbit_s, 3) as median,
                    round(p95_kbit_s, 3) as p95, round(max_kbit_s, 3) as max
             from object_bitrate_summary where direction = 'created'
             order by scope desc, track_name`))
            .toEqual([
                { scope: "track", track_name: "1.m4s", bytes: 7000, seconds: 3, span_s: 4,
                  mean: 10, p5: 8, median: 8, p95: 22.4, max: 24 },
                { scope: "track", track_name: "2.m4s", bytes: 600, seconds: 4, span_s: 4,
                  mean: 0.8, p5: 0.8, median: 0.8, p95: 0.8, max: 0.8 },
                { scope: "all", track_name: null, bytes: 7600, seconds: 4, span_s: 4,
                  mean: 10.8, p5: 2, median: 8.8, p95: 22.4, max: 24.8 },
            ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a capture with no relay has hops but no dwell", () => {
    const dir = tmp("mlog-dwell-none-");
    try {
        const sender = writeLog(dir, "s.jsonl", header("client"), [
            subscribe(1, 5, "/bbb", "1.m4s"), subscribeOk(2, 5, 5),
            subgroupHeader("created", 9, 2, 5, 7), object("created", 10, 2, 7, 0),
        ]);
        const receiver = writeLog(dir, "r.jsonl", header("server"), [
            subscribe(1, 4, "/bbb", "1.m4s"), subscribeOk(2, 4, 4),
            subgroupHeader("parsed", 59, 2, 4, 7), object("parsed", 60, 2, 7, 0),
        ]);
        const db = join(dir, "norelay.db");
        expect(loadInto(db, [
            { log: sender, cid: "c1" }, { log: receiver, cid: "c1" },
        ]).ok).toBe(true);

        // one connection, so nothing was forwarded onward
        expect(query<{ n: number }>(db, "select count(*) as n from hop")[0]!.n).toBe(1);
        expect(query<{ n: number }>(db, "select count(*) as n from dwell")[0]!.n).toBe(0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A sender/receiver pair on one connection, for the trust tests below. */
function pairedCapture(dir: string, tag: string,
                       sends: [number, number][], recvs: [number, number][]) {
    const sender = writeLog(dir, `${tag}-s.jsonl`, header("client"), [
        subscribe(1, 5, "/bbb", "1.m4s"), subscribeOk(2, 5, 5),
        subgroupHeader("created", 9, 2, 5, 7),
        ...sends.map(([t, id]) => object("created", t, 2, 7, id)),
    ]);
    const receiver = writeLog(dir, `${tag}-r.jsonl`, header("server"), [
        subscribe(1, 4, "/bbb", "1.m4s"), subscribeOk(2, 4, 4),
        subgroupHeader("parsed", 49, 2, 4, 7),
        ...recvs.map(([t, id]) => object("parsed", t, 2, 7, id)),
    ]);
    const db = join(dir, `${tag}.db`);
    const r = loadInto(db, [{ log: sender, cid: "c1" }, { log: receiver, cid: "c1" }]);
    return { db, ok: r.ok };
}

type Trust = { sent: number; received: number; joined: number;
               lost: number; outside_window: number };

const trustOf = (db: string) => query<Trust>(db,
    `select sent::int as sent, received::int as received, joined::int as joined,
            lost::int as lost, outside_window::int as outside_window from trust`)[0]!;

test("an object dropped mid-run counts as lost", () => {
    const dir = tmp("mlog-trust-lost-");
    try {
        // three sent; the middle one never arrives, and the run continues after it
        const { db, ok } = pairedCapture(dir, "lost",
            [[10, 0], [20, 1], [30, 2]], [[60, 0], [80, 2]]);
        expect(ok).toBe(true);

        expect(trustOf(db)).toEqual({
            sent: 3, received: 2, joined: 2, lost: 1, outside_window: 0,
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("objects sent after the receiver stopped recording are not loss", () => {
    const dir = tmp("mlog-trust-tail-");
    try {
        // same three sent, but the receiver's log ends after the first
        const { db, ok } = pairedCapture(dir, "tail",
            [[10, 0], [20, 1], [30, 2]], [[60, 0]]);
        expect(ok).toBe(true);

        // two did not join, but nothing shows the network dropped them
        expect(trustOf(db)).toEqual({
            sent: 3, received: 1, joined: 1, lost: 0, outside_window: 2,
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a clean connection reports no loss and no orphans", () => {
    const dir = tmp("mlog-trust-clean-");
    try {
        const { db, ok } = pairedCapture(dir, "clean",
            [[10, 0], [20, 1], [30, 2]], [[60, 0], [70, 1], [80, 2]]);
        expect(ok).toBe(true);

        expect(trustOf(db)).toEqual({
            sent: 3, received: 3, joined: 3, lost: 0, outside_window: 0,
        });
        expect(query<{ n: number }>(db,
            "select negative_hops::int as n from trust")[0]!.n).toBe(0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a receiver clock behind the sender's shows up as a negative hop", () => {
    const dir = tmp("mlog-trust-neg-");
    try {
        // receiver decodes at t=5 what the sender built at t=10: impossible
        // without clock disagreement, so the count is evidence, not a guess
        const { db, ok } = pairedCapture(dir, "neg", [[10, 0]], [[5, 0]]);
        expect(ok).toBe(true);

        expect(query<{ joined: number; neg: number }>(db,
            "select joined::int as joined, negative_hops::int as neg from trust"))
            .toEqual([{ joined: 1, neg: 1 }]);
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
