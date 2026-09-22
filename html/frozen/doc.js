// FROZEN. A copy of lib/doc.js as it stood at the first extraction, kept only
// so experiment 5 and experiment 6 still run. Current code lives in
// lib/chart-option.js and lib/markdown.js, which is this file split in two so a
// pre-rendered page can import the chart helpers without pulling in `marked`.
// Do not fix bugs here; fix them there.
//
// ---
//
// The half of a markdown-charts page that runs without a DOM.
//
// Everything here is a pure function of its input: markdown in, HTML and a
// heading list out; fence text in, an ECharts option out. That is the point of
// the file -- a build script has to import this to pre-render a page and to
// check its fences, and it cannot import anything that touches `document` or
// defines a custom element.
//
// The bare 'marked' specifier resolves through the page's importmap in a
// browser, and through node_modules in a build. Nothing else is imported.

import { Marked } from 'marked';

// --- chart options ------------------------------------------------ //

// Charts sit in a prose column, so their content should start where the text
// does -- the 15% default leaves them visibly indented against the paragraphs
// above. `grid` is the plot area and axis labels fall outside it, so
// containLabel folds the labels into the 0 instead of letting them hang.
// `right` is left at its 10% default; this is about aligning the left edge.
//
// The name says prose on purpose: a page that is not a prose column -- a
// dashboard, say -- wants its own grid, not this one.
export const PROSE_GRID = { left: '1%', containLabel: true };

/** Page defaults under the fence's own option, so a fence can always override. */
export function withDefaults(option) {
  return {
    backgroundColor: 'transparent',
    ...option,
    // A shallow spread would drop the grid defaults the moment a fence set any
    // grid key of its own, so merge that one level deliberately.
    grid: Array.isArray(option.grid)
      ? option.grid.map((g) => ({ ...PROSE_GRID, ...g }))
      : { ...PROSE_GRID, ...option.grid },
  };
}

/** Strict JSON first, then a JS object literal. Throws if neither parses. */
export function parseChartOption(src) {
  try {
    return JSON.parse(src);
  } catch {
    // The fallback buys unquoted keys, trailing commas and comments, which is
    // most of why writing ECharts options by hand is tolerable. It is an eval,
    // so it trusts the markdown exactly as much as rendering that markdown to
    // HTML already does: fine for documents we author, not for ones we receive.
    return Function(`"use strict"; return (${src});`)();
  }
}

// --- markdown ------------------------------------------------------ //
// Two renderer overrides, the same mechanism aimed at different tokens: one
// turns an ```echarts fence into an element, the other restores heading ids,
// which marked v15 no longer emits, so a sidebar's anchors resolve.
//
// The heading override is also the only place that knows a heading's slug, so
// it is the only honest place to collect them for the sidebar.

export function createMarkdownRenderer() {
  const headings = [];
  const marked = new Marked();
  marked.use({
    renderer: {
      code({ text, lang }) {
        if (lang !== 'echarts') return false;   // false = use the default renderer
        return `<app-echart config="${encodeURIComponent(text.trim())}"></app-echart>\n`;
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
