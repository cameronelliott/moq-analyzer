import { test, expect, describe } from "bun:test";
import { renderMarkdown, MarkdownError } from "./markdown";
import { html } from "./html";
import type { PageModel } from "./fields";

const MODEL: PageModel = {
    fields: {
        title: "real-6pop <demo>",
        description: "d",
        publisher: "Tokyo",
        relay: "N. Virginia",
        trace_count: "10",
        connection_count: "5",
        subscriber_count: "4",
        objects_published: "73,084",
        lost_objects: "0",
        leg1_median_ms: "75.90",
        e2e_mean_ms: "132.63",
    },
    blocks: {
        hosts: html`<table><tr><td>${"Tokyo"}</td></tr></table>`,
        legs: html`<p>legs</p>`,
        trust: html`<p>trust</p>`,
    },
};

const render = (src: string, model: PageModel | null = MODEL) => renderMarkdown(src, model).value;

describe("fields", () => {
    test("a field becomes a span holding the escaped value", () => {
        expect(render("# {{title}}")).toBe(
            '<h1><span data-field="title">real-6pop &lt;demo&gt;</span></h1>\n');
    });

    test("with no model, a field shows the empty mark and keeps its span", () => {
        expect(render("Leg 1 median: {{leg1_median_ms}} ms", null)).toBe(
            '<p>Leg 1 median: <span data-field="leg1_median_ms">—</span> ms</p>\n');
    });

    test("fields work inside emphasis, lists, tables and link text", () => {
        const out = render([
            "**{{trace_count}}** traces",
            "",
            "- {{subscriber_count}} subscribers",
            "",
            "| n |",
            "|---|",
            "| {{trace_count}} |",
            "",
            "[{{title}}](/showcase/real-6pop/)",
        ].join("\n"));
        expect(out).toContain('<strong><span data-field="trace_count">10</span></strong>');
        expect(out).toContain('<li><span data-field="subscriber_count">4</span> subscribers</li>');
        expect(out).toContain('<td><span data-field="trace_count">10</span></td>');
        expect(out).toContain('<a href="/showcase/real-6pop/"><span data-field="title">');
    });

    test("an escaped brace is literal text", () => {
        expect(render("\\{\\{title}}")).toBe("<p>{{title}}</p>\n");
    });
});

describe("blocks", () => {
    test("a block on its own line becomes a div holding the block's HTML", () => {
        expect(render("Hosts:\n\n{{> hosts}}\n\nAfter.")).toBe(
            "<p>Hosts:</p>\n"
            + '<div data-block="hosts"><table><tr><td>Tokyo</td></tr></table></div>\n'
            + "<p>After.</p>\n");
    });

    test("with no model, a block is an empty div", () => {
        expect(render("{{> legs}}", null)).toBe('<div data-block="legs"></div>\n');
    });

    test("a block right after a paragraph line still stands alone", () => {
        expect(render("Hosts:\n{{> hosts}}")).toContain('<div data-block="hosts">');
    });
});

describe("refusals", () => {
    const refuses = (src: string, pattern: RegExp) => {
        expect(() => render(src)).toThrow(MarkdownError);
        expect(() => render(src)).toThrow(pattern);
    };

    test("unknown field", () => refuses("{{titel}}", /unknown field \{\{titel\}\}/));
    test("unknown block", () => refuses("{{> tables}}", /unknown block/));
    test("placeholder in a code span", () => refuses("`{{title}}`", /inside code/));
    test("placeholder in a fenced block", () => refuses("```\n{{title}}\n```", /inside code/));
    test("placeholder in a link URL", () => refuses("[x](/s/{{title}}/)", /link URL/));
    test("placeholder in raw HTML", () => refuses('<div title="{{title}}"></div>', /raw HTML/));
    test("block placeholder mid-sentence", () => refuses("see {{> hosts}} here", /not a placeholder/));
    test("spaces inside a field", () => refuses("{{ title }}", /not a placeholder/));
});

describe("raw HTML", () => {
    test("markdown between blank lines inside an element is parsed", () => {
        const out = render('<section class="note">\n\n**{{trace_count}}** traces\n\n</section>');
        expect(out).toContain('<section class="note">');
        expect(out).toContain('<strong><span data-field="trace_count">10</span></strong>');
    });
});

test("pure: same input, same output, no state carried between calls", () => {
    const src = "# {{title}}\n\n{{> legs}}";
    const a = render(src);
    render("{{> trust}}", null);
    expect(render(src)).toBe(a);
});
