// Proves the `shape` table catches JSON schema drift in moq-rs mlogs.
//   bun test
//
// Each case builds a small mlog fixture, runs schema.sql + load_file.sql + load_common.sql over it
// with the real duckdb CLI, and inspects what the loader recorded.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = import.meta.dir;

const HEADER = {
    qlog_version: "0.3",
    qlog_format: "JSON-SEQ",
    title: "drift-test",
    description: "MoQ Transport events",
    trace: {
        vantage_point: { type: "client" },
        common_fields: { reference_time: 1788560083342.7483, time_format: "relative" },
        moq_rs_flush_policy: "buffered",
        event_schemas: ["urn:ietf:params:qlog:events:moqt"],
    },
};

const subscribe = (time: number, id: number, name: string) => ({
    time,
    name: "moqt:control_message_created",
    data: {
        event_type: "control_message_created",
        stream_id: 0,
        message_type: "subscribe",
        subscribe_id: id,
        track_namespace: "/bbb",
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
        parameters: [["9", "[00 00]"]],
        track_extensions: [],
    },
});

const header = (time: number, stream: number, alias: number, group: number) => ({
    time,
    name: "moqt:subgroup_header_parsed",
    data: {
        event_type: "subgroup_header_parsed",
        stream_id: stream,
        header_type: "SubgroupIdExt",
        track_alias: alias,
        group_id: group,
        publisher_priority: 0,
        subgroup_id: 0,
    },
});

const object = (
    time: number,
    stream: number,
    objectId: number,
    extra: Record<string, unknown> = {},
) => ({
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
        ...extra,
    },
});

/** A minimal well-formed trace: one subscribe, one stream, one object. */
const clean = () => [
    subscribe(1, 0, "0.mp4"),
    subscribeOk(2, 0, 0),
    header(3, 7, 0, 0),
    object(4, 7, 0),
];

// shape.fingerprint is VARCHAR so it can be a primary key; the query below casts
// it back to JSON, which duckdb -json then emits as a nested object
type Shape = {
    name: string;
    n: number;
    unconsumed: string[];
    fingerprint: Record<string, unknown>;
};

type RunOpts = {
    /** Prefix each line with the RFC 7464 record separator, as a .jsonseq does. */
    recordSeparators?: boolean;
    /** Extra raw lines appended verbatim, to exercise malformed input. */
    rawLines?: string[];
};

function run(events: unknown[], opts: RunOpts = {}) {
    const dir = mkdtempSync(join(tmpdir(), "mlog-drift-"));
    try {
        const log = join(dir, opts.recordSeparators ? "fixture.jsonseq" : "fixture.jsonl");
        const db = join(dir, "fixture.db");
        const rs = opts.recordSeparators ? "\x1e" : "";
        const body = [HEADER, ...events].map((o) => rs + JSON.stringify(o));
        writeFileSync(log, [...body, ...(opts.rawLines ?? []).map((l) => rs + l)].join("\n") + "\n");

        const load = Bun.spawnSync([
            "duckdb", db,
            "-f", join(REPO, "schema.sql"),
            "-c", `set variable src='${log}'; set variable trace_id=1;`,
            "-f", join(REPO, "load_file.sql"),
            "-f", join(REPO, "load_common.sql"),
        ]);

        const query = <T>(sql: string): T[] => {
            const r = Bun.spawnSync(["duckdb", "-json", db, "-c", sql]);
            if (r.exitCode !== 0) throw new Error(r.stderr.toString());
            const out = r.stdout.toString().trim();
            return out ? JSON.parse(out) : [];
        };

        const ok = load.exitCode === 0;
        return {
            ok,
            // load_common.sql ends with the drift report, so this is the operator-facing warning
            report: load.stdout.toString(),
            stderr: load.stderr.toString(),
            shape: ok ? query<Shape>("select name, n, unconsumed, fingerprint::JSON as fingerprint from shape order by n desc, name") : [],
            other: ok ? query<{ name: string }>("select name from event_other") : [],
            objects: ok
                ? one(query<{ n: number }>("select count(*) as n from subgroup_object"), "objects").n
                : 0,
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const shapeFor = (shapes: Shape[], name: string) =>
    shapes.filter((s) => s.name === `moqt:${name}`);

/** The one row a query must return; fails loudly rather than undefined. */
function one<T>(rows: T[], what: string): T {
    const [row, ...rest] = rows;
    if (row === undefined || rest.length > 0) {
        throw new Error(`${what}: expected exactly 1 row, got ${rows.length}`);
    }
    return row;
}

test("a clean trace reports no drift", () => {
    const r = run(clean());
    expect(r.ok).toBe(true);

    // one shape per event type, nothing unaccounted for
    expect(r.shape.map((s) => s.name).sort()).toEqual([
        "moqt:control_message_created",
        "moqt:control_message_parsed",
        "moqt:subgroup_header_parsed",
        "moqt:subgroup_object_parsed",
    ]);
    for (const s of r.shape) expect(s.unconsumed).toEqual([]);

    // the drift report is the thing an operator reads; it must be quiet here
    expect(r.report).not.toContain("moqt:");
});

test("a new field in a known event is reported as unconsumed", () => {
    const r = run([...clean(), object(5, 7, 1, { object_status: 1 })]);
    expect(r.ok).toBe(true);

    const drifted = shapeFor(r.shape, "subgroup_object_parsed").filter(
        (s) => s.unconsumed.length > 0,
    );
    const shape = one(drifted, "drifted shape");
    expect(shape.unconsumed).toEqual(["object_status"]);
    expect(shape.n).toBe(1);

    // and it surfaces in the report, not just the table
    expect(r.report).toContain("object_status");

    // the row still loads -- drift is reported, never a reason to drop data
    expect(r.objects).toBe(2);
});

test("a field that changes type produces a second shape", () => {
    const r = run([...clean(), object(5, 7, 1, { stream_id: "7" })]);
    expect(r.ok).toBe(true);

    const shapes = shapeFor(r.shape, "subgroup_object_parsed");
    expect(shapes).toHaveLength(2);
    expect(shapes.map((s) => s.fingerprint.stream_id).sort()).toEqual([
        "UBIGINT",
        "VARCHAR",
    ]);

    // stream_id is a key the loader does read, so this is not an unconsumed key.
    // Only the fingerprint catches it -- which is why key-set diffing is not enough.
    for (const s of shapes) expect(s.unconsumed).toEqual([]);

    // and with nothing unconsumed, the baseline is the only thing that can warn
    expect(r.report).toContain("shape not in baseline");
    expect(r.report).toContain('"stream_id":"VARCHAR"');
});

test("a dropped field produces a second shape", () => {
    // rebuilt without the field rather than deleted, so no cast is needed
    const full = object(5, 7, 1);
    const { object_payload_length: _dropped, ...data } = full.data;
    const partial = { ...full, data };

    const r = run([...clean(), partial]);
    expect(r.ok).toBe(true);

    const shapes = shapeFor(r.shape, "subgroup_object_parsed");
    expect(shapes).toHaveLength(2);
    expect(shapes.some((s) => !("object_payload_length" in s.fingerprint))).toBe(true);
});

test("an unknown event type is kept whole, and is not drift", () => {
    const r = run([
        ...clean(),
        { time: 5, name: "moqt:fetch_header_parsed", data: { event_type: "fetch_header_parsed", stream_id: 4, brand_new_field: true } },
    ]);
    expect(r.ok).toBe(true);

    expect(r.other.map((o) => o.name)).toEqual(["moqt:fetch_header_parsed"]);

    // event_other stores the object verbatim, so no key is unconsumed
    const shape = one(shapeFor(r.shape, "fetch_header_parsed"), "fetch_header shape");
    expect(shape.unconsumed).toEqual([]);
    expect(shape.fingerprint.brand_new_field).toBe("BOOLEAN");
});

test("a heterogeneous array does not abort the load", () => {
    // json_structure has to walk this; if it throws, the transaction rolls back
    // and a single odd line costs the whole trace.
    const r = run([...clean(), object(5, 7, 1, { extension_headers: [1, "two", { three: 3 }] })]);

    expect(r.stderr).toBe("");
    expect(r.ok).toBe(true);
    expect(r.objects).toBe(2);
});

test("drift is a warning, not a failure -- the trace still loads", () => {
    // an operator has to be able to read the warning, judge it, and carry on;
    // a shape they have not blessed must never cost them the load
    const r = run([...clean(), object(5, 7, 1, { stream_id: "7" })]);

    expect(r.ok).toBe(true);
    expect(r.stderr).toBe("");
    expect(r.report).toContain("shape not in baseline");
    expect(r.objects).toBe(2);
});

test("a baselined shape is reported only for unread keys, not for itself", () => {
    // clean() is entirely baselined, so a single new key is the only warning --
    // the other four shapes must stay silent rather than all being flagged
    const r = run([...clean(), object(5, 7, 1, { object_status: 1 })]);
    expect(r.ok).toBe(true);

    const warned = r.report.split("\n").filter((l) => l.includes("moqt:"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("subgroup_object_parsed");
    expect(r.report).toContain("object_status");
});

test("RFC 7464 record separators load identically to plain lines", () => {
    // read_ndjson_objects rejects a 0x1e outright, so load_file.sql splits lines with
    // read_csv and strips the separator itself. The two formats must be the same
    // trace, not merely both loadable.
    const events = [...clean(), object(5, 7, 1), object(6, 7, 2)];
    const plain = run(events);
    const jsonseq = run(events, { recordSeparators: true });

    expect(jsonseq.stderr).toBe("");
    expect(jsonseq.ok).toBe(true);
    expect(jsonseq.objects).toBe(plain.objects);
    expect(jsonseq.shape).toEqual(plain.shape);
    expect(jsonseq.other).toEqual(plain.other);
});

test("a malformed line aborts the load and names the offending text", () => {
    const r = run(clean(), { rawLines: ['{"time":9.0,"name":"moqt:truncated"'] });

    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("Malformed JSON in file");
    // the line itself is quoted back, which locates it better than a byte offset
    expect(r.stderr).toContain('"name":"moqt:truncated"');
});

test("a blank line is ignored rather than treated as malformed", () => {
    const r = run(clean(), { rawLines: ["", "   "] });

    expect(r.stderr).toBe("");
    expect(r.ok).toBe(true);
    expect(r.objects).toBe(1);
});
