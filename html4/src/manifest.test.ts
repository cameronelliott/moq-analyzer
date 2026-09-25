import { test, expect, describe } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    isGzip, manifestFromFiles, ManifestError, parseManifest, traceName, type Manifest,
} from "./manifest";

const HTML4 = join(import.meta.dir, "..");
const REAL_6POP_MANIFEST = join(HTML4, "showcase", "real-6pop", "manifest.json");
const REAL_6POP_DATA = join(HTML4, "..", "..", "a1", "data", "real-6pop");

// JSON.parse returns any; typing it unknown is the point -- parseManifest checks it.
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("real-6pop manifest", () => {
    const m = parseManifest(readJson(REAL_6POP_MANIFEST));

    test("parses, with ten traces and six hosts", () => {
        expect(m.id).toBe("real-6pop");
        expect(m.traces).toHaveLength(10);
        expect(m.hosts).toHaveLength(6);
    });

    test("every connection is logged at both ends", () => {
        const byCid = new Map<string, string[]>();
        for (const t of m.traces) byCid.set(t.cid, [...(byCid.get(t.cid) ?? []), t.end]);
        expect(byCid.size).toBe(5);
        for (const ends of byCid.values()) expect(ends.sort()).toEqual(["client", "server"]);
    });

    test.skipIf(!existsSync(REAL_6POP_DATA))("lists exactly the mlogs on disk", () => {
        const onDisk = readdirSync(REAL_6POP_DATA).filter((f) => f.endsWith(".mlog.gz")).sort();
        expect(m.traces.map((t) => t.url)).toEqual(onDisk);
    });

    test.skipIf(!existsSync(REAL_6POP_DATA))("hosts agree with city-mapping.json", () => {
        // city-mapping.json is a hand-written file in a1; its shape is assumed
        // here, and a wrong assumption fails the comparison below.
        const city = JSON.parse(readFileSync(join(REAL_6POP_DATA, "city-mapping.json"), "utf8")) as {
            hosts: { role: string; cid: string | null; region: string; city: string }[];
        };
        const expected = city.hosts.map(({ role, cid, region, city }) => ({ role, cid, region, city }));
        const got: { role: string; cid: string | null; region?: string; city: string }[] = m.hosts.map((h) => ({
            role: h.role, cid: h.cid, region: h.region, city: h.label.replace(/ \(sub\d\)$/, ""),
        }));
        const key = (x: { cid: unknown; role: unknown }) => `${String(x.role)}/${String(x.cid)}`;
        expect([...got].sort((a, b) => key(a).localeCompare(key(b))))
            .toEqual([...expected].sort((a, b) => key(a).localeCompare(key(b))));
    });
});

describe("parseManifest refuses", () => {
    const base = (): Record<string, unknown> => ({
        version: 1,
        id: "t",
        title: "T",
        description: "",
        traces: [
            { url: "a_client.mlog.gz", cid: "a", end: "client" },
            { url: "a_server.mlog", cid: "a", end: "server" },
        ],
        hosts: [{ label: "Tokyo", role: "publisher", cid: "a" }],
    });
    const trace = (m: Record<string, unknown>, i: number): Record<string, unknown> =>
        (m["traces"] as Record<string, unknown>[])[i]!;                  // built by base() above
    const host = (m: Record<string, unknown>, i: number): Record<string, unknown> =>
        (m["hosts"] as Record<string, unknown>[])[i]!;                   // built by base() above

    const cases: [string, (m: Record<string, unknown>) => void, string, RegExp][] = [
        ["a wrong version", (m) => { m["version"] = 2; }, "$.version", /expected 1/],
        ["an unknown key", (m) => { m["titel"] = "x"; }, "$.titel", /unknown key/],
        ["a bad id", (m) => { m["id"] = "Real 6pop"; }, "$.id", /does not match/],
        ["an empty title", (m) => { m["title"] = " "; }, "$.title", /empty/],
        ["no traces", (m) => { m["traces"] = []; }, "$.traces", /no mlog files/],
        ["a bad end", (m) => { trace(m, 1)["end"] = "relay"; }, "$.traces[1].end", /one of/],
        ["a quote in a cid", (m) => { trace(m, 0)["cid"] = "a'b"; }, "$.traces[0].cid", /does not match/],
        ["a javascript: URL", (m) => { trace(m, 0)["url"] = "javascript:x.mlog"; }, "$.traces[0].url", /scheme javascript/],
        ["a protocol-relative URL", (m) => { trace(m, 0)["url"] = "//evil.example/a.mlog"; }, "$.traces[0].url", /protocol-relative/],
        ["a non-mlog file", (m) => { trace(m, 0)["url"] = "a_client.qlog.gz"; }, "$.traces[0].url", /\.mlog/],
        ["two URLs naming one file", (m) => { trace(m, 1)["url"] = "x/a_client.mlog"; }, "$.traces[1].url", /same file name/],
        ["a host cid with no trace", (m) => { host(m, 0)["cid"] = "b"; }, "$.hosts[0].cid", /no trace has cid b/],
        ["two hosts with one cid", (m) => {
            (m["hosts"] as unknown[]).push({ label: "Sydney", role: "subscriber", cid: "a" });  // hosts is an array in base()
        }, "$.hosts[1].cid", /same cid as \$\.hosts\[0\]/],
        ["a bad role",(m) => { host(m, 0)["role"] = "viewer"; }, "$.hosts[0].role", /one of/],
        ["a lowercase airport", (m) => { host(m, 0)["airport"] = "nrt"; }, "$.hosts[0].airport", /does not match/],
        ["a latitude past 90", (m) => { host(m, 0)["lat"] = 91; }, "$.hosts[0].lat", /-90 to 90/],
        ["an unknown host key", (m) => { host(m, 0)["city"] = "Tokyo"; }, "$.hosts[0].city", /unknown key/],
    ];

    test("the base is valid", () => {
        expect(parseManifest(base()).traces).toHaveLength(2);
    });

    for (const [name, mutate, path, message] of cases) {
        test(name, () => {
            const m = base();
            mutate(m);
            let err: unknown;
            try {
                parseManifest(m);
            } catch (e) {
                err = e;
            }
            expect(err).toBeInstanceOf(ManifestError);
            if (!(err instanceof ManifestError)) return;
            expect(err.path).toBe(path);
            expect(err.message).toMatch(message);
        });
    }

    test("something that is not an object", () => {
        expect(() => parseManifest([])).toThrow(/manifest \$: expected an object/);
    });
});

describe("trace helpers", () => {
    test("traceName drops the path, the query and .gz", () => {
        const t = { url: "https://x.example/s/a_client.mlog.gz?v=1", cid: "a", end: "client" } as const;
        expect(traceName(t)).toBe("a_client.mlog");
        expect(isGzip(t)).toBe(true);
        expect(isGzip({ ...t, url: "a_client.mlog" })).toBe(false);
    });
});

describe("manifestFromFiles", () => {
    // The real-6pop directory as a directory pick reports it.
    const PICKED = [
        "CLAUDE.md",
        "a5163379d342db3bb2e10e6b3db6b598_client.mlog.gz",
        "a5163379d342db3bb2e10e6b3db6b598_server.mlog.gz",
        "a5163379d342db3bb2e10e6b3db6b598_server.qlog.gz",
        "c45a526b08ad99ea276b9813b0f66ac5_client.mlog.gz",
        "c45a526b08ad99ea276b9813b0f66ac5_server.mlog.gz",
        "cbdf0223f28262d1bd8e0ea465070b62_client.mlog.gz",
        "cbdf0223f28262d1bd8e0ea465070b62_server.mlog.gz",
        "city-mapping.json",
        "clock/pub.csv",
        "d69664a3df26f06f765548d35e4115d2_client.mlog.gz",
        "d69664a3df26f06f765548d35e4115d2_server.mlog.gz",
        "fb8ac5324b8a68c291bea912edbc0bd0_client.mlog.gz",
        "fb8ac5324b8a68c291bea912edbc0bd0_server.mlog.gz",
        "session.duckdb",
    ].map((f) => `real-6pop/${f}`);

    test("keeps the mlogs, skips the rest, and says what it skipped", () => {
        const { manifest, skipped } = manifestFromFiles(PICKED);
        expect(manifest.traces).toHaveLength(10);
        expect(manifest.traces[0]).toEqual({
            url: "a5163379d342db3bb2e10e6b3db6b598_client.mlog.gz",
            cid: "a5163379d342db3bb2e10e6b3db6b598",
            end: "client",
        });
        expect(manifest.hosts).toEqual([]);
        expect(skipped).toEqual([
            "real-6pop/CLAUDE.md",
            "real-6pop/a5163379d342db3bb2e10e6b3db6b598_server.qlog.gz",
            "real-6pop/city-mapping.json",
            "real-6pop/clock/pub.csv",
            "real-6pop/session.duckdb",
        ]);
    });

    test("what it makes passes parseManifest", () => {
        const { manifest } = manifestFromFiles(PICKED);
        const again: Manifest = parseManifest(JSON.parse(JSON.stringify(manifest)));
        expect(again).toEqual(manifest);
    });

    test("two files with one name, from two folders, is an error", () => {
        expect(() => manifestFromFiles(["x/a_client.mlog", "y/a_client.mlog.gz"]))
            .toThrow(/two files are named a_client\.mlog/);
    });

    test("no mlogs at all is an error", () => {
        expect(() => manifestFromFiles(["notes.md", "a.qlog"])).toThrow(/no <cid>_<client\|server>/);
    });
});
