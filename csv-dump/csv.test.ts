import { test, expect } from "bun:test";
import { csvField, csvLines } from "./csv";

test("plain values pass through", () => {
    expect(csvField("abc")).toBe("abc");
    expect(csvField(42)).toBe("42");
    expect(csvField(0.5)).toBe("0.5");
});

test("NULL is an empty field, and an empty string is quoted to stay distinct", () => {
    expect(csvField(null)).toBe("");
    expect(csvField("")).toBe('""');
});

test("comma, quote, CR and LF force quoting; quotes double", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField("a\rb")).toBe('"a\rb"');
});

test("lines: header, then rows in column order, CRLF-free", () => {
    type R = { readonly a: string; readonly b: number | null };
    const rows: R[] = [{ a: "x", b: 1 }, { a: "y,z", b: null }];
    expect([...csvLines(["b", "a"], rows)]).toEqual(["b,a\n", '1,x\n', ',"y,z"\n']);
});
