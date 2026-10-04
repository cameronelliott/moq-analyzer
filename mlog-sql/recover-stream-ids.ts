// Puts stream ids back on a trace that stock moq-rs wrote.
//
// Stock moq-rs writes stream_id 0 on every subgroup event, so no object can be
// tied to its stream, and through the stream to its track. The classifier
// recovers which objects share a stream; this file reads the classifier's
// input out of the mlog text, writes the recovered ids back, and decides which
// traces need it.
//
// BATCH ONLY, as classifier.ts is: a trace that needs repair is held whole in
// memory. A trace with real ids passes through in chunks, untouched.

import {
    assignHeaders, classify,
    type ObjectInput, type ParsedHeader,
} from "./classifier";

type Dir = "created" | "parsed";
const DIRS: readonly Dir[] = ["created", "parsed"];
const CONTROL_EVENTS = new Set(["moqt:control_message_created", "moqt:control_message_parsed"]);
const RS = "\x1e";

/** Which subgroup event a record name is, or null for any other record. */
function subgroupEvent(name: unknown): { kind: "object" | "header"; dir: Dir } | null {
    for (const dir of DIRS) {
        if (name === `moqt:subgroup_object_${dir}`) return { kind: "object", dir };
        if (name === `moqt:subgroup_header_${dir}`) return { kind: "header", dir };
    }
    return null;
}

export interface ClassifierInput {
    objects: ObjectInput[];
    headers: ParsedHeader[];
    /** Header events per (group_id, subgroup_id). One header is written per
     *  real stream, and the events survive the corruption -- only their
     *  stream_id field is zeroed -- so this is the exact stream count. */
    bucketStreams: Map<string, number>;
    /** Distinct track aliases in SUBSCRIBE_OK. The corruption does not touch
     *  the control messages, so this is an honest track count. */
    trackCount: number;
    /** The record each object and each header came from, by position. */
    objectAt: number[];
    headerAt: number[];
}

/** Split mlog text into records. A record ends at an RFC 7464 separator or at
 *  a newline, so .jsonseq and .jsonl both split, as they do in load.sql. JSON
 *  escapes both characters inside strings, so neither can split a record. */
export function records(raw: string): string[] {
    return raw.split(/[\x1e\n]/).map((c) => c.trim()).filter((c) => c.length > 0);
}

/** One key of a parsed record, or undefined when the value is not an object. */
export function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function num(value: unknown, key: string): number | null {
    const v = field(value, key);
    return typeof v === "number" ? v : null;
}

/** A record's JSON, or undefined when the text is not JSON. */
export function parseRecord(line: string): unknown {
    try {
        // JSON.parse gives `any`; nothing is assumed about the shape here.
        // Every read goes through field() and num(), which check it.
        return JSON.parse(line) as unknown;
    } catch {
        return undefined;
    }
}

/** What the classifier needs, from parsed records. With `dir`, only the
 *  subgroup events of that direction; the track count is of the whole trace
 *  either way. A subgroup event missing a field the classifier needs is left
 *  out, so it gets no recovered id. */
function collect(parsed: readonly unknown[], dir?: Dir): ClassifierInput {
    const objects: ObjectInput[] = [];
    const headers: ParsedHeader[] = [];
    const objectAt: number[] = [];
    const headerAt: number[] = [];
    const bucketStreams = new Map<string, number>();
    const aliases = new Set<number>();

    parsed.forEach((rec, at) => {
        const name = field(rec, "name");
        const d = field(rec, "data");
        const event = subgroupEvent(name);

        if (event === null) {
            const track_alias = num(d, "track_alias");
            if (typeof name === "string" && CONTROL_EVENTS.has(name) &&
                field(d, "message_type") === "subscribe_ok" && track_alias !== null) {
                aliases.add(track_alias);
            }
            return;
        }
        if (dir !== undefined && event.dir !== dir) return;

        const time = num(rec, "time");
        const group_id = num(d, "group_id");
        const subgroup_id = num(d, "subgroup_id");
        if (time === null || group_id === null || subgroup_id === null) return;

        if (event.kind === "object") {
            const object_id = num(d, "object_id");
            const payload_length = num(d, "object_payload_length");
            if (object_id === null || payload_length === null) return;
            objects.push({ time, group_id, subgroup_id, object_id, payload_length });
            objectAt.push(at);
        } else {
            const track_alias = num(d, "track_alias");
            if (track_alias === null) return;
            headers.push({ time, group_id, subgroup_id, track_alias });
            headerAt.push(at);
            const key = group_id + "/" + subgroup_id;
            bucketStreams.set(key, (bucketStreams.get(key) ?? 0) + 1);
        }
    });

    return {
        objects, headers, bucketStreams, objectAt, headerAt,
        trackCount: aliases.size === 0 ? 2 : aliases.size,
    };
}

export function readCapture(raw: string, dir?: Dir): ClassifierInput {
    return collect(records(raw).map(parseRecord), dir);
}

// --- which traces need it ---------------------------------------------------

/**
 * True when a subgroup header's stream_id can be a real one.
 *
 * A subgroup rides a QUIC unidirectional stream, and RFC 9000 2.1 gives those
 * the ids with bit 1 set: 2, 3, 6, 7, and so on. Stock moq-rs writes 0, which
 * is a bidirectional stream, so it is never a real subgroup stream. A missing
 * field is not real either.
 */
export function isRealStreamId(streamId: unknown): boolean {
    return typeof streamId === "number" && Number.isInteger(streamId) &&
           Math.floor(streamId / 2) % 2 === 1;
}

/** The first subgroup header in the text says which kind of trace this is.
 *  undefined when the text has no subgroup header. */
export function hasRealStreamIds(text: string): boolean | undefined {
    for (const line of records(text)) {
        if (!line.includes('"moqt:subgroup_header_')) continue;
        const rec = parseRecord(line);
        if (subgroupEvent(field(rec, "name"))?.kind !== "header") continue;
        return isRealStreamId(field(field(rec, "data"), "stream_id"));
    }
    return undefined;
}

// --- the repair -------------------------------------------------------------

export interface RepairStats {
    /** Subgroup objects in the trace. */
    objects: number;
    /** Objects with a recovered id where another grouping scored nearly as well. */
    uncertain: number;
    /** Objects the classifier could not place. They are left out of the output. */
    unresolved: number;
}

/**
 * A recovered id, as the mlog carries it. The classifier counts -1, -2, ... in
 * each direction. Recovered ids are multiples of 4, which are bidirectional
 * stream ids, so one can never be mistaken for a real subgroup stream. The two
 * directions get disjoint ids, as real streams have: load.sql refuses a
 * stream_id that appears in both.
 */
function recoveredId(classifierId: number, dir: Dir): number {
    return 4 * (2 * -classifierId - (dir === "created" ? 1 : 0));
}

/**
 * Recover the stream ids of one trace and write them back.
 *
 * Returns the trace as records, each with its separator and newline. Only the
 * stream_id of subgroup events changes, and the header gains three keys that
 * load.sql reads: moq_stream_id_source, moq_stream_id_uncertain and
 * moq_stream_id_unresolved. A record that is not JSON passes through.
 *
 * A subgroup event that got no id is left out. With the other events rewritten
 * it could join nothing, and two headers that both kept 0 would collide on the
 * loader's key.
 */
export function repair(raw: string): { records: string[]; stats: RepairStats } {
    const lines = records(raw);
    const parsed = lines.map(parseRecord);
    const ids = new Map<number, number>();
    const stats: RepairStats = { objects: 0, uncertain: 0, unresolved: 0 };

    for (const dir of DIRS) {
        const cap = collect(parsed, dir);
        const objects = classify(cap.objects, cap.trackCount, cap.bucketStreams);
        const headers = assignHeaders(objects, cap.headers);
        objects.forEach((o, k) => {
            const at = cap.objectAt[k];
            if (at === undefined || o.stream_id === null) return;
            ids.set(at, recoveredId(o.stream_id, dir));
            if (o.certainty === "uncertain") stats.uncertain++;
        });
        headers.forEach((h, k) => {
            const at = cap.headerAt[k];
            if (at === undefined || h.stream_id === null) return;
            ids.set(at, recoveredId(h.stream_id, dir));
        });
    }

    const out: string[] = [];
    let headerAt: number | undefined;
    let headerRecord: unknown;
    parsed.forEach((rec, at) => {
        const line = lines[at];
        if (line === undefined) return;
        const event = subgroupEvent(field(rec, "name"));
        if (event === null) {
            // The trace header is the one record with `trace` and no `name`.
            if (headerAt === undefined && typeof field(rec, "trace") === "object" &&
                field(rec, "trace") !== null) {
                headerAt = out.length;
                headerRecord = rec;
            }
            out.push(RS + line + "\n");
            return;
        }
        if (event.kind === "object") stats.objects++;
        const id = ids.get(at);
        const data = field(rec, "data");
        if (id === undefined || typeof data !== "object" || data === null) {
            if (event.kind === "object") stats.unresolved++;
            return;
        }
        Reflect.set(data, "stream_id", id);
        out.push(RS + JSON.stringify(rec) + "\n");
    });

    const trace = field(headerRecord, "trace");
    if (headerAt !== undefined && typeof trace === "object" && trace !== null) {
        Reflect.set(trace, "moq_stream_id_source", "recovered");
        Reflect.set(trace, "moq_stream_id_uncertain", stats.uncertain);
        Reflect.set(trace, "moq_stream_id_unresolved", stats.unresolved);
        out[headerAt] = RS + JSON.stringify(headerRecord) + "\n";
    }
    return { records: out, stats };
}

/**
 * One trace's chunks, with stream ids recovered when the trace has none.
 *
 * Each incoming chunk must hold whole records, as recordChunks yields them.
 * The first subgroup header decides. A trace with real ids passes through as
 * it arrives. Any other trace is read to its end, repaired, and yielded in
 * chunks of about `target` bytes. A trace with no subgroup header at all
 * passes through unchanged, after its end.
 */
export async function* withStreamIds(
    chunks: AsyncIterable<Uint8Array>,
    target: number,
): AsyncGenerator<Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const pending: Uint8Array[] = [];
    let real: boolean | undefined;

    for await (const chunk of chunks) {
        if (real === true) {
            yield chunk;
            continue;
        }
        pending.push(chunk);
        if (real === undefined) {
            // A chunk holds whole records, so it also holds whole UTF-8 characters.
            real = hasRealStreamIds(decoder.decode(chunk));
            if (real === true) {
                yield* pending;
                pending.length = 0;
            }
        }
    }
    if (real !== false) {
        yield* pending;
        return;
    }

    const repaired = repair(pending.map((c) => decoder.decode(c)).join("")).records;
    pending.length = 0;
    let batch: string[] = [];
    let size = 0;
    for (const record of repaired) {
        batch.push(record);
        size += record.length;
        if (size >= target) {
            yield encoder.encode(batch.join(""));
            batch = [];
            size = 0;
        }
    }
    if (batch.length > 0) yield encoder.encode(batch.join(""));
}
