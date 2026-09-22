// Markdown to HTML, with two renderer overrides.
//
// Copied from ../html/lib/markdown.js. One deliberate change: CHART_TAG and
// CHART_LANG are inlined rather than imported from chart-option.js, because
// those two strings were the only thing this module took from that file and the
// other 65 lines of it are chart-only. If charts come back, re-import instead of
// keeping two copies of the constants.
//
// The same mechanism aimed at different tokens: one turns an ```echarts fence
// into an element, the other restores heading ids, which marked no longer
// emits, so a sidebar's anchors resolve.
//
// The heading override is also the only place that knows a heading's slug, so it
// is the only honest place to collect them for the sidebar.
//
// This is the only module that imports `marked`, which is what lets a
// pre-rendered page leave the parser out of its bundle entirely. Pure: no
// `document`, no custom elements, so the build imports it in node, and the
// browser imports the identical file. That sameness is the point -- see
// markdown.test.js, which renders both ways and diffs.

import { Marked } from 'marked';

export const CHART_TAG = 'app-echart';
export const CHART_LANG = 'echarts';

export function createMarkdownRenderer() {
  const headings = [];
  const marked = new Marked();
  marked.use({
    renderer: {
      code({ text, lang }) {
        if (lang !== CHART_LANG) return false;   // false = use the default renderer
        const config = encodeURIComponent(text.trim());
        return `<${CHART_TAG} config="${config}"></${CHART_TAG}>\n`;
      },
      // A shorthand method, not an arrow, so `this` is the renderer and
      // `this.parser` exists.
      heading({ tokens, depth }) {
        const markup = this.parser.parseInline(tokens);
        const text = markup.replace(/<[^>]+>/g, '');   // e.g. <code> in a heading
        const id = text
          .toLowerCase()
          .replace(/[^\w]+/g, '-')
          .replace(/^-+|-+$/g, '');
        headings.push({ depth, id, text });
        return `<h${depth} id="${id}">${markup}</h${depth}>\n`;
      },
    },
  });

  return {
    /** Markdown in; HTML out, plus the headings that HTML got ids for. */
    render(src) {
      headings.length = 0;
      const body = marked.parse(src);
      return { body, headings: [...headings] };
    },
  };
}

/** The first h1's text, or ''. No front matter, so the title and the heading
 *  cannot disagree. */
export function titleOf(headings) {
  return headings.find((h) => h.depth === 1)?.text ?? '';
}

// navHtml() lives in ../html/lib/build.js and is not copied here: the sidebar is
// a second question, and the prose diff already tests the one-renderer
// invariant it existed to protect.
