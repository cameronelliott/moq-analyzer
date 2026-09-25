// Markdown to HTML, with two placeholders:
//
//   {{field}}    inline. Becomes <span data-field="field">value</span>.
//   {{> block}}  on its own line. Becomes <div data-block="block">...</div>.
//
// With a model (showcase build) the values are written in. With null (the
// empty analyzer page) fields show "—" and blocks are empty, and the browser
// fills both later. Either way the markup is the same, so the browser only
// ever sets textContent on a span or innerHTML on a block's div.
//
// A pure function: no fs, no DOM, a fresh Marked instance per call. It runs
// in Bun at build time, and can be bundled for the browser if a page ever has
// to change markdown structure at browse time.
//
// Only for our own markdown files. Raw HTML passes through, and marked does
// not sanitize, so text from a manifest or an mlog never goes through here.

import { Marked, type Token, type Tokens, type TokenizerAndRendererExtension } from "marked";
import { html, trustedHtml, type SafeHtml } from "./html";
import { EMPTY_FIELD, isBlockName, isFieldName, type BlockName, type FieldName, type PageModel } from "./fields";

export class MarkdownError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MarkdownError";
    }
}

const NAME = "[a-z][a-z0-9_]*";
const FIELD_RE = new RegExp(`^\\{\\{(${NAME})\\}\\}`);
const BLOCK_RE = new RegExp(`^\\{\\{> (${NAME})\\}\\}[ \\t]*(?:\\n|$)`);
const BLOCK_START_RE = /^\{\{> /m;

/** A string property of a marked token, or "" when absent. */
function prop(t: Token | Tokens.Generic, key: string): string {
    const v: unknown = Reflect.get(t, key);
    return typeof v === "string" ? v : "";
}

function fieldName(t: Tokens.Generic): FieldName {
    const n = prop(t, "name");
    if (!isFieldName(n)) throw new MarkdownError(`unknown field {{${n}}}`);
    return n;
}

function blockName(t: Tokens.Generic): BlockName {
    const n = prop(t, "name");
    if (!isBlockName(n)) throw new MarkdownError(`unknown block {{> ${n}}}`);
    return n;
}

/** Refuse a placeholder anywhere it would not be replaced. */
function checkToken(t: Token): void {
    const has = (key: string) => prop(t, key).includes("{{");
    switch (t.type) {
        case "code":
        case "codespan":
            if (has("text")) throw new MarkdownError(`placeholder inside code: ${prop(t, "raw").trim()}`);
            break;
        case "link":
        case "image":
            if (has("href") || has("title")) {
                throw new MarkdownError(`placeholder inside a link URL or title: ${prop(t, "raw")}`);
            }
            break;
        case "html":
            if (has("text")) throw new MarkdownError(`placeholder inside raw HTML: ${prop(t, "raw").trim()}`);
            break;
        case "text":
            // A text token with children is checked through them.
            if (Reflect.get(t, "tokens") === undefined && has("text")) {
                throw new MarkdownError(
                    `not a placeholder: ${prop(t, "text").trim()}`
                    + " (use {{name}} inline, or {{> name}} alone on its own line)");
            }
            break;
    }
}

export function renderMarkdown(src: string, model: PageModel | null): SafeHtml {
    const field: TokenizerAndRendererExtension = {
        name: "field",
        level: "inline",
        start(s) {
            const i = s.indexOf("{{");
            return i < 0 ? undefined : i;
        },
        tokenizer(s) {
            const m = FIELD_RE.exec(s);
            if (m === null) return undefined;
            const name = m[1] ?? "";
            if (!isFieldName(name)) throw new MarkdownError(`unknown field {{${name}}}`);
            return { type: "field", raw: m[0], name };
        },
        renderer(t) {
            const name = fieldName(t);
            const text = model === null ? EMPTY_FIELD : model.fields[name];
            return html`<span data-field="${name}">${text}</span>`.value;
        },
    };

    const block: TokenizerAndRendererExtension = {
        name: "block",
        level: "block",
        start(s) {
            return BLOCK_START_RE.exec(s)?.index;
        },
        tokenizer(s) {
            const m = BLOCK_RE.exec(s);
            if (m === null) return undefined;
            const name = m[1] ?? "";
            if (!isBlockName(name)) throw new MarkdownError(`unknown block {{> ${name}}}`);
            return { type: "block", raw: m[0], name };
        },
        renderer(t) {
            const name = blockName(t);
            const inner = model === null ? trustedHtml("") : model.blocks[name];
            return html`<div data-block="${name}">${inner}</div>\n`.value;
        },
    };

    const md = new Marked({ extensions: [field, block], walkTokens: checkToken });
    return trustedHtml(md.parse(src, { async: false }));
}
