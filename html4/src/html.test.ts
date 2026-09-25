import { test, expect } from "bun:test";
import { escapeHtml, html, SafeHtml, trustedHtml } from "./html";

const ATTACK = `<script>alert("x")</script>&'`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;";

test("escapeHtml covers the five characters", () => {
    expect(escapeHtml(ATTACK)).toBe(ESCAPED);
});

test("interpolated strings are escaped, in content and in attributes", () => {
    expect(html`<p title="${ATTACK}">${ATTACK}</p>`.value)
        .toBe(`<p title="${ESCAPED}">${ESCAPED}</p>`);
});

test("numbers are written as text", () => {
    expect(html`<td>${75.9}</td><td>${0}</td>`.value).toBe("<td>75.9</td><td>0</td>");
});

test("SafeHtml nests without being escaped again", () => {
    const cell = html`<td>${"a<b"}</td>`;
    expect(html`<tr>${cell}</tr>`.value).toBe("<tr><td>a&lt;b</td></tr>");
});

test("a list is joined, each item escaped on its own terms", () => {
    const rows = ["<1>", "2"].map((s) => html`<li>${s}</li>`);
    expect(html`<ul>${rows}</ul>`.value).toBe("<ul><li>&lt;1&gt;</li><li>2</li></ul>");
    expect(html`${["<", trustedHtml("<b>")]}`.value).toBe("&lt;<b>");
});

test("SafeHtml cannot be made without html`` or trustedHtml()", () => {
    // The token is module-private; anything else is refused at runtime.
    expect(() => Reflect.construct(SafeHtml, ["<x>", Symbol("SafeHtml")]))
        .toThrow(/SafeHtml comes from/);
});
