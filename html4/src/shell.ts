// The page around the content: head, header, main. One shell for the showcase
// pages and the analyzer, so both carry the same markup and stylesheet.
// Paths are root-relative: the site is served from the root of its host.

import { html, type SafeHtml } from "./html";

export interface PageOptions {
    readonly title: string;
    /** Plain text for <meta name="description">. */
    readonly description: string;
    readonly body: SafeHtml;
    /** Module scripts, root-relative. The showcase pages have none. */
    readonly scripts?: readonly string[];
}

export function page(o: PageOptions): SafeHtml {
    const scripts = (o.scripts ?? []).map((src) => html`<script type="module" src="${src}"></script>`);
    return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title}</title>
<meta name="description" content="${o.description}">
<link rel="stylesheet" href="/style.css">
${scripts}
</head>
<body>
<header class="site"><a href="/">MoQ session analyzer</a>
<nav><a href="/showcase/">Showcase</a> <a href="/analyzer/">Analyzer</a></nav></header>
<main>
${o.body}
</main>
</body>
</html>
`;
}
