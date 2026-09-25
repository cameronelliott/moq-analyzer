// html4 reaches mlog-sql only through the package name, so package.json
// "exports" decides what it can see. A relative path into ../mlog-sql skips that
// check, so this test refuses one.
//   bun test imports

import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

test("no source file imports mlog-sql by path", () => {
    const offenders: string[] = [];
    for (const dir of ["src", "build"]) {
        for (const name of readdirSync(join(ROOT, dir))) {
            if (!name.endsWith(".ts")) continue;
            const text = readFileSync(join(ROOT, dir, name), "utf8");
            for (const [i, line] of text.split("\n").entries()) {
                if (/["'][^"']*\/mlog-sql[/"']/.test(line)) offenders.push(`${dir}/${name}:${i + 1}`);
            }
        }
    }
    expect(offenders).toEqual([]);
});
