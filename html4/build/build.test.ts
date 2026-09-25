// Runs the real build into a temp dir and reads the output the way a crawler
// would: as HTML text, with no JavaScript. Skips when a1/data is absent.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, BuildError, type BuiltSession } from "./build";
import { parseManifest } from "../src/manifest";
import { FIELDS } from "../src/fields";

const DATA = join(import.meta.dir, "..", "..", "..", "a1", "data");
const HAVE_DATA = existsSync(join(DATA, "real-6pop"));

describe.skipIf(!HAVE_DATA)("build", () => {
    const tmp = mkdtempSync(join(tmpdir(), "html4-build-"));
    const out = join(tmp, "dist");
    let built: BuiltSession[] = [];
    let pageHtml = "";

    beforeAll(async () => {
        built = await build({ data: DATA, out });
        pageHtml = readFileSync(join(out, "showcase", "real-6pop", "index.html"), "utf8");
    }, 300_000);

    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    test("builds the real-6pop session", () => {
        expect(built.map((b) => b.id)).toEqual(["real-6pop"]);
        expect(built[0]?.traces).toBe(10);
    });

    test("every field is in the HTML with a value, not the empty mark", () => {
        for (const f of FIELDS) {
            const m = new RegExp(`<span data-field="${f}">([^<]*)</span>`).exec(pageHtml);
            expect(m, f).not.toBeNull();
            expect(m?.[1], f).not.toBe("—");
        }
    });

    test("the numbers a reader and a crawler see", () => {
        // Leg 1 is one hop measured by four subscribers; the medians agree.
        expect(pageHtml).toMatch(/<span data-field="leg1_median_ms">75\.\d\d(–75\.\d\d)?<\/span>/);
        expect(pageHtml).toContain('<span data-field="subscriber_count">4</span>');
        expect(pageHtml).toContain('<span data-field="publisher">Tokyo</span>');
        const legRows = /<div data-block="legs">[\s\S]*?<\/div>/.exec(pageHtml)?.[0].match(/<th scope="row">/g) ?? [];
        expect(legRows).toHaveLength(4);
    });

    test("the showcase page needs no JavaScript", () => {
        expect(pageHtml).not.toContain("<script");
    });

    test("it links to the analyzer with its manifest", () => {
        expect(pageHtml).toContain('href="/analyzer/?src=%2Fshowcase%2Freal-6pop%2Fmanifest.json"');
        const m = parseManifest(JSON.parse(readFileSync(join(out, "showcase", "real-6pop", "manifest.json"), "utf8")));
        expect(m.id).toBe("real-6pop");
    });

    test("the mlogs are copied byte for byte", () => {
        const m = parseManifest(JSON.parse(readFileSync(join(out, "showcase", "real-6pop", "manifest.json"), "utf8")));
        for (const t of m.traces) {
            expect(statSync(join(out, "showcase", "real-6pop", t.url)).size)
                .toBe(statSync(join(DATA, "real-6pop", t.url)).size);
        }
    });

    test("index pages link to the session", () => {
        expect(readFileSync(join(out, "showcase", "index.html"), "utf8")).toContain('href="/showcase/real-6pop/"');
        expect(readFileSync(join(out, "index.html"), "utf8")).toContain('href="/showcase/"');
        expect(existsSync(join(out, "style.css"))).toBe(true);
    });

    test("a rebuild replaces its own output", async () => {
        writeFileSync(join(out, "stale.txt"), "x");
        await build({ data: DATA, out });
        expect(existsSync(join(out, "stale.txt"))).toBe(false);
    }, 300_000);
});

test("the build refuses to delete a directory it did not make", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "html4-build-"));
    try {
        const out = join(tmp, "not-ours");
        mkdirSync(out);
        writeFileSync(join(out, "precious.txt"), "keep");
        await expect(build({ data: DATA, out })).rejects.toThrow(BuildError);
        expect(readFileSync(join(out, "precious.txt"), "utf8")).toBe("keep");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});
