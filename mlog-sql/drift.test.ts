// Proves the `shape` table catches JSON schema drift in moq-rs mlogs.
//   bun test
//
// Each case builds a small mlog fixture, runs schema.sql + load.sql over it
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

/** The newer request_id vocabulary, which this build emits beside subscribe_id. */
const publishNamespace = (time: number, requestId: number) => ({
    time,
    name: "moqt:control_message_created",
    data: {
        event_type: "control_message_created",
        stream_id: 0,
        message_type: "publish_namespace",
        request_id: requestId,
        track_namespace: "/bbb",
        parameters: [],
    },
});

const requestOk = (time: number, requestId: number, kind: string) => ({
    time,
    name: "moqt:control_message_parsed",
    data: {
        event_type: "control_message_parsed",
        stream_id: 0,
        message_type: "request_ok",
        request_id: requestId,
        request_kind: kind,
        parameters: [],
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

type ControlMessage = {
    message_type: string;
    direction: string;
    subscribe_id: number | null;
    request_id: number | null;
    request_kind: string | null;
    track_namespace: string | null;
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
            "-c", `set variable src='${log}';`,
            "-f", join(REPO, "load.sql"),
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
            // load.sql ends with the drift report, so this is the operator-facing warning
            report: load.stdout.toString(),
            stderr: load.stderr.toString(),
            shape: ok ? query<Shape>("select name, n, unconsumed, fingerprint::JSON as fingerprint from shape order by n desc, name") : [],
            other: ok ? query<{ name: string }>("select name from event_other") : [],
            control: ok ? query<ControlMessage>(
                `select message_type, direction::VARCHAR as direction, subscribe_id,
                        request_id, request_kind, track_namespace
                 from control_message order by time_us`) : [],
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

test("request_id and request_kind are stored, not read past", () => {
    // Before they had columns, a request_ok landed as a row with a message_type
    // and nothing else: no id to tie it to the request it answered. The line was
    // not kept in event_other either, since its event name was recognised -- so
    // the only two fields carrying meaning were gone for good.
    const r = run([...clean(), publishNamespace(5, 7), requestOk(6, 7, "publish_namespace")]);

    expect(r.ok).toBe(true);
    expect(shapeFor(r.shape, "control_message_created")
        .concat(shapeFor(r.shape, "control_message_parsed"))
        .flatMap((s) => s.unconsumed)).toEqual([]);

    const byType = Object.fromEntries(r.control.map((c) => [c.message_type, c]));
    expect(byType.publish_namespace).toEqual({
        message_type: "publish_namespace", direction: "created",
        subscribe_id: null, request_id: 7, request_kind: null, track_namespace: "/bbb",
    });
    // the id is what ties the acknowledgement back to what it acknowledged
    expect(byType.request_ok).toEqual({
        message_type: "request_ok", direction: "parsed",
        subscribe_id: null, request_id: 7, request_kind: "publish_namespace",
        track_namespace: null,
    });

    // and subscribe_id is untouched by any of it
    expect(byType.subscribe?.subscribe_id).toBe(0);
    expect(byType.subscribe?.request_id).toBe(null);
});

test("every control message shape in a real session is baselined", () => {
    // The baseline was built from a trace holding only subscribe/subscribe_ok, so
    // a whole session -- setup, publish_namespace, request_ok, unsubscribe -- used
    // to report a dozen shapes as drift on every healthy load. A report that
    // always fires is a report nobody reads.
    const r = run([...clean(), publishNamespace(5, 7), requestOk(6, 7, "publish_namespace")]);

    expect(r.ok).toBe(true);
    // same convention as the clean-trace test above: the empty table frame is
    // tolerated, an event name in the report is not
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
    // read_ndjson_objects rejects a 0x1e outright, so load.sql splits lines with
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
