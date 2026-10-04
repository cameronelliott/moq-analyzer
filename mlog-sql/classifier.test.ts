// The classifier, measured against ground truth.
//
// The fixtures are the client files of n1 and n4 in a1/data, which carry a
// real `stream_id`. The classifier never sees it: `ObjectInput` has no
// `stream_id` field, so a test cannot leak ground truth into the guess.
// The tests skip when a1/data is absent.
//
// Two metrics, because either alone can be gamed:
//
//   purity        for each inferred cluster, credit its majority true label.
//                 Fragmenting into many tiny pure clusters scores 1.0.
//   completeness  for each REAL stream, the fraction of its rows that landed
//                 in one cluster. Lumping everything together scores 1.0.
//
// Both 1.0 means an exact bijection, which is what the DP partition achieves.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { classify, type ObjectInput } from "./classifier";
import { field, parseRecord, readCapture, records } from "./recover-stream-ids";

const DATA = join(import.meta.dir, "..", "..", "a1", "data");

const FIXTURES = [
    "n1/07922abf16b51b0f396f947a1348243b_client.mlog",
    "n1/79a9a6a83db2a5c9c449e9f5eda2dc1e_client.mlog",
    // n4 is larger and structurally different, so it guards against overfitting
    // to n1's collision pattern.
    "n4/6fac82b7993a0d5c38b4422152c06ef9_client.mlog",
    "n4/83f3da602572863849756e6cb1ffdab7_client.mlog",
    "n4/ac129b4e9f2a07a763b4392e0b42216a_client.mlog",
    "n4/d0a53c4ddd206cc5d28350e2719a7e3f_client.mlog",
    "n4/db21ebaf21e23eaef959152ccf65c217_client.mlog",
];

/** The real stream ids, read separately so the classifier never sees them.
 *  Skips the records readCapture skips, so the two lists stay index-aligned. */
function groundTruth(raw: string): number[] {
    const out: number[] = [];
    for (const line of records(raw)) {
        const rec = parseRecord(line);
        const name = field(rec, "name");
        if (name !== "moqt:subgroup_object_created" && name !== "moqt:subgroup_object_parsed") continue;
        const d = field(rec, "data");
        const required = [field(rec, "time"), field(d, "group_id"), field(d, "subgroup_id"),
                          field(d, "object_id"), field(d, "object_payload_length")];
        if (required.some((v) => typeof v !== "number")) continue;
        const sid = field(d, "stream_id");
        if (typeof sid !== "number") throw new Error(`fixture object without a stream_id: ${line}`);
        out.push(sid);
    }
    return out;
}

/** The partition an id assignment induces: a set of groups, each a list of the
 *  object positions that share an id. Compared as text, so two partitions are
 *  equal exactly when they group the same objects together, whatever the ids
 *  are called. */
function partition(ids: (number | null)[]): string[] {
    const groups = new Map<number, number[]>();
    ids.forEach((id, i) => {
        if (id === null) return;
        const g = groups.get(id);
        if (g) g.push(i); else groups.set(id, [i]);
    });
    return [...groups.values()].map((g) => g.join(",")).sort();
}

const majoritySum = (m: Map<number, Map<number, number>>) =>
    [...m.values()].reduce((s, counts) => s + Math.max(...counts.values()), 0);

function bump(m: Map<number, Map<number, number>>, outer: number, inner: number): void {
    const counts = m.get(outer) ?? new Map<number, number>();
    counts.set(inner, (counts.get(inner) ?? 0) + 1);
    m.set(outer, counts);
}

describe.skipIf(!existsSync(DATA))("classifier against a1/data", () => {
    for (const file of FIXTURES) {
        test(`recovers the real stream grouping of ${file}`, () => {
            const raw = readFileSync(join(DATA, file), "utf8");
            const cap = readCapture(raw);
            const truth = groundTruth(raw);
            expect(cap.objects.length).toBeGreaterThan(0);
            expect(truth.length).toBe(cap.objects.length);
            // The fixture must carry real ids, or this measures nothing.
            expect(new Set(truth).size).toBeGreaterThan(1);

            const guesses = classify(cap.objects, cap.trackCount, cap.bucketStreams);
            expect(guesses.length).toBe(truth.length);

            const clusterTruth = new Map<number, Map<number, number>>();
            const realSpread = new Map<number, Map<number, number>>();
            let assigned = 0;
            guesses.forEach((g, i) => {
                const real = truth[i];
                if (g.stream_id === null || real === undefined) return;
                bump(clusterTruth, g.stream_id, real);
                bump(realSpread, real, g.stream_id);
                assigned++;
            });

            // The DP partition measures exactly 1.0 on every fixture, with
            // nothing unresolved, so anything below is a real loss.
            expect(guesses.filter((g) => g.certainty === "unresolved").length).toBe(0);
            expect(majoritySum(clusterTruth) / assigned).toBeGreaterThanOrEqual(0.999);
            expect(majoritySum(realSpread) / assigned).toBeGreaterThanOrEqual(0.999);
            // Equal counts with both at 1.0: neither fragmented nor lumped.
            expect(clusterTruth.size).toBe(realSpread.size);

            // The same claim, said directly: the recovered ids group the same
            // objects together as the real ones. The values differ, and must:
            // a recovered id is negative, so it is never mistaken for a real one.
            expect(guesses.every((g) => g.stream_id === null || g.stream_id < 0)).toBe(true);
            expect(partition(guesses.map((g) => g.stream_id))).toEqual(partition(truth));
        });
    }

    test("the classifier cannot see the field it reconstructs", () => {
        const probe: ObjectInput = {
            time: 0, group_id: 0, subgroup_id: 0, object_id: 0, payload_length: 1,
        };
        expect(Object.keys(probe)).not.toContain("stream_id");
        const fixture = FIXTURES[0];
        if (fixture === undefined) throw new Error("no fixtures");
        const cap = readCapture(readFileSync(join(DATA, fixture), "utf8"));
        for (const o of cap.objects) expect("stream_id" in o).toBe(false);
    });
});

test("records() splits .jsonseq and .jsonl the same way", () => {
    const a = '{"name":"x","time":1}';
    const b = '{"name":"y","time":2}';
    expect(records(`\x1e${a}\n\x1e${b}\n`)).toEqual([a, b]);
    expect(records(`${a}\n${b}\n`)).toEqual([a, b]);
});
