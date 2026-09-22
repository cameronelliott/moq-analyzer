// What a build needs from a document that a browser does not.
//
// Pure, and importable in node: nothing here touches `document` or registers an
// element. A site's build script calls buildDoc() for each markdown file and
// navHtml() for its sidebar, and owns everything else -- where files live, what
// the shell says, where output goes.
//
// The HTML comes from the same renderer <app-markdown> uses at runtime, not a
// second implementation. That is the point: a document rendered at build time
// and the same document rendered in a live page have to agree, and the only way
// to be sure is for there to be one renderer.

import { Marked } from 'marked';

import { CHART_LANG, parseChartOption, seriesTypesOf } from './chart-option.js';
import { createMarkdownRenderer } from './markdown.js';

const renderer = createMarkdownRenderer();
const lexer = new Marked();

/** Walks nested tokens -- fences inside lists and blockquotes count too. */
function* eachToken(tokens) {
  for (const token of tokens ?? []) {
    yield token;
    yield* eachToken(token.tokens);
    yield* eachToken(token.items);
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A markdown document, ready to drop into a page shell.
 *
 * Returns:
 *   html         the rendered body
 *   title        the first h1's text, or '' -- no front matter, and no way for
 *                the title and the heading to disagree
 *   headings     [{ depth, id, text }], in document order
 *   charts       one entry per echarts fence: { source, seriesTypes, error }
 *   seriesTypes  every series type the document draws with, sorted
 *   errors       fences that would not parse. A caller that cares about a
 *                broken chart failing the build checks this; nothing throws,
 *                because reporting every bad fence at once beats reporting the
 *                first one.
 */
export function buildDoc(markdown) {
  const { body, headings } = renderer.render(markdown);

  const charts = [];
  for (const token of eachToken(lexer.lexer(markdown))) {
    if (token.type !== 'code' || token.lang !== CHART_LANG) continue;
    const source = token.text.trim();
    try {
      charts.push({ source, seriesTypes: seriesTypesOf(parseChartOption(source)), error: null });
    } catch (err) {
      charts.push({
        source,
        seriesTypes: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const seriesTypes = [...new Set(charts.flatMap((c) => c.seriesTypes))].sort();

  return {
    html: body,
    title: headings.find((h) => h.depth === 1)?.text ?? '',
    headings,
    charts,
    seriesTypes,
    errors: charts.filter((c) => c.error),
  };
}

/**
 * The sidebar as HTML, from the headings buildDoc reported.
 *
 * Deliberately the same shape bindNav() builds at runtime -- same href, same
 * data-drawer, same text -- so a pre-rendered page and a live one get the same
 * sidebar. bindNav sets textContent and is escaped by the DOM; this escapes by
 * hand, which is the one difference worth watching.
 */
export function navHtml(headings, { depth = 2 } = {}) {
  return headings
    .filter((h) => h.depth === depth)
    .map((h) => `<a href="#${escapeHtml(h.id)}" data-drawer="close">${escapeHtml(h.text)}</a>`)
    .join('\n');
}
