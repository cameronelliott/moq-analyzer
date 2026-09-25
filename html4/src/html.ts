// HTML as strings, escaped by default. Runs in Bun at build time and in the
// browser, so no DOM and no fs.
//
// SafeHtml is a class, not a branded string: html`` has to tell at runtime
// which values to escape, and a brand exists only in the type checker. It has
// no toString, so pasting one into a plain template literal shows up as
// "[object Object]" instead of quietly mixing trusted and untrusted text.

const TOKEN: unique symbol = Symbol("SafeHtml");

export class SafeHtml {
    readonly value: string;
    constructor(value: string, token: typeof TOKEN) {
        if (token !== TOKEN) throw new Error("SafeHtml comes from html`` or trustedHtml()");
        this.value = value;
    }
}

type Scalar = string | number | SafeHtml;
export type HtmlValue = Scalar | readonly Scalar[];

// Array.isArray does not narrow a readonly array out of a union; this does.
const isList = (v: HtmlValue): v is readonly Scalar[] => Array.isArray(v);

const ESCAPES: Readonly<Record<string, string>> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Escape text for element content and for quoted attribute values. */
export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function one(v: Scalar): string {
    return v instanceof SafeHtml ? v.value : escapeHtml(String(v));
}

/** Build HTML. Every interpolated value is escaped unless it is SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
    let out = strings[0] ?? "";
    values.forEach((v, i) => {
        out += (isList(v) ? v.map(one).join("") : one(v)) + (strings[i + 1] ?? "");
    });
    return new SafeHtml(out, TOKEN);
}

/**
 * Mark a string as HTML without escaping it. Only for HTML that no untrusted
 * input reached: markdown.ts output from our own markdown files, and tests.
 * Grep for this name when auditing.
 */
export function trustedHtml(s: string): SafeHtml {
    return new SafeHtml(s, TOKEN);
}
