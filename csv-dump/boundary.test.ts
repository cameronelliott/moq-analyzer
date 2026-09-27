// This project may use only what mlog-sql's package.json "exports" allows.
// The specifiers are variables, so tsc does not resolve them; bun does at runtime.
import { test, expect } from "bun:test";

test("the package entry gives exactly the public values", async () => {
    const entry = "mlog-sql";
    expect(Object.keys(await import(entry)).sort()).toEqual(["CaptureError", "openCapture"]);
});

test("internal files are not importable", async () => {
    for (const path of ["mlog-sql/api-internal", "mlog-sql/api", "mlog-sql/schema.sql"]) {
        await expect(import(path)).rejects.toThrow();
    }
});
