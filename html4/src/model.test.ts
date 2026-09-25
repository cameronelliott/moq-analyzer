import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LegSummaryRow, TrustRow } from "mlog-sql";
import { buildModel, labeler } from "./model";
import { BLOCKS, FIELDS } from "./fields";
import { fmtMsRange } from "./format";
import { parseManifest, type Manifest } from "./manifest";
import { renderMarkdown } from "./markdown";

const MANIFEST_PATH = join(import.meta.dir, "..", "showcase", "real-6pop", "manifest.json");
// JSON.parse returns any; typing it unknown is the point -- parseManifest checks it.
const rawManifest = (): Record<string, unknown> => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const MANIFEST = parseManifest(rawManifest());

const PUB = "c45a526b08ad99ea276b9813b0f66ac5";
const IRELAND = "cbdf0223f28262d1bd8e0ea465070b62";
const SYDNEY = "fb8ac5324b8a68c291bea912edbc0bd0";
const STRAY = "zzzz9999aaaa";   // in the rows, not in the manifest

const leg = (sub_cid: string, leg_no: number, median_ms: number, mean_ms: number, n = 1000): LegSummaryRow => ({
    sub_cid, leg_no, leg: ["", "pub -> relay", "relay dwell", "relay -> sub"][leg_no] ?? "", n,
    mean_ms, median_ms, p95_ms: median_ms * 2,
});

const LEGS: LegSummaryRow[] = [
    leg(SYDNEY, 1, 75.91, 74.95), leg(SYDNEY, 2, 0.40, 2.00), leg(SYDNEY, 3, 98.00, 98.20, 52000),
    leg(IRELAND, 1, 75.90, 74.94), leg(IRELAND, 2, 0.30, 1.91), leg(IRELAND, 3, 34.10, 34.50, 70000),
    leg(STRAY, 1, 75.92, 75.00),
];

const trust = (cid: string, sender_is: string | null, sent: number, lost: number, outside_window = 0): TrustRow => ({
    cid, sender_is, sent, received: sent - lost, joined: sent - lost - outside_window,
    lost, outside_window, negative_hops: 0,
});

const TRUST: TrustRow[] = [
    trust(PUB, "client", 73084, 2),
    trust(IRELAND, "server", 70124, 0, 750),
];

describe("buildModel", () => {
    const model = buildModel(MANIFEST, { legs: LEGS, trust: TRUST });

    test("fields", () => {
        expect(model.fields).toEqual({
            title: MANIFEST.title,
            description: MANIFEST.description,
            publisher: "Tokyo",
            relay: "N. Virginia",
            trace_count: "10",
            connection_count: "5",
            subscriber_count: "3",
            objects_published: "73,084",
            lost_objects: "2",
            leg1_median_ms: "75.90–75.92",
            e2e_mean_ms: "111.35–175.15",   // 74.94+1.91+34.50, 74.95+2.00+98.20
        });
    });

    test("every field and block is filled", () => {
        for (const f of FIELDS) expect(model.fields[f].length).toBeGreaterThan(0);
        for (const b of BLOCKS) expect(model.blocks[b].value.length).toBeGreaterThan(0);
    });

    test("legs: fastest end to end first, a subscriber missing legs last", () => {
        const order = [...model.blocks.legs.value.matchAll(/<th scope="row">([^<]*)<\/th>/g)].map((m) => m[1]);
        expect(order).toEqual(["Ireland (sub1)", "Sydney (sub3)", "zzzz9999…"]);
        expect(model.blocks.legs.value).toContain('<td class="num">111.35</td>');
    });

    test("trust: counts are grouped, labels come from the manifest", () => {
        expect(model.blocks.trust.value).toContain('<th scope="row">Tokyo</th><td>client</td><td class="num">73,084</td>');
    });

    test("hosts: every host, with its airport", () => {
        const rows = model.blocks.hosts.value.match(/<tr>\n<th scope="row">/g) ?? [];
        expect(rows).toHaveLength(6);
        expect(model.blocks.hosts.value).toContain("<td>ap-south-1</td><td>BOM</td>");
    });

    test("manifest text is escaped in every block", () => {
        const raw = rawManifest();
        const hosts = raw["hosts"] as Record<string, unknown>[];   // shape checked by parseManifest above
        hosts[0]!["label"] = "<img src=x onerror=alert(1)>";
        const m: Manifest = parseManifest(raw);
        const hostile = buildModel(m, { legs: LEGS, trust: TRUST });
        for (const b of BLOCKS) expect(hostile.blocks[b].value).not.toContain("<img");
        expect(hostile.blocks.trust.value).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    test("no rows: empty blocks say so, fields stay honest", () => {
        const empty = buildModel(MANIFEST, { legs: [], trust: [] });
        expect(empty.fields.subscriber_count).toBe("0");
        expect(empty.fields.leg1_median_ms).toBe("—");
        expect(empty.blocks.legs.value).toContain("No object crossed");
    });

    test("the model renders through markdown with every name", () => {
        const src = FIELDS.map((f) => `{{${f}}}`).join(" ") + "\n\n"
            + BLOCKS.map((b) => `{{> ${b}}}`).join("\n\n");
        const out = renderMarkdown(src, model).value;
        for (const f of FIELDS) expect(out).toContain(`data-field="${f}"`);
        for (const b of BLOCKS) expect(out).toContain(`data-block="${b}"`);
    });
});

describe("helpers", () => {
    test("labeler: manifest label, else a short cid", () => {
        const label = labeler(MANIFEST);
        expect(label(PUB)).toBe("Tokyo");
        expect(label(STRAY)).toBe("zzzz9999…");
        expect(label("abc")).toBe("abc");
    });

    test("fmtMsRange collapses equal values and orders the ends", () => {
        expect(fmtMsRange([75.904, 75.896])).toBe("75.90");
        expect(fmtMsRange([2, 1.5])).toBe("1.50–2.00");
        expect(fmtMsRange([])).toBe("—");
    });
});
