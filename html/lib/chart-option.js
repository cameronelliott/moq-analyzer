// Chart options: the names both sides agree on, the page defaults, and the
// fence dialects.
//
// Imports nothing. That is the whole reason this is not part of markdown.js:
// the chart element needs these helpers, and if they arrived through a module
// that imports `marked`, every pre-rendered page would ship a markdown parser
// it never calls. A file boundary here is a bundle boundary.

/**
 * The element an `echarts` fence becomes. The markdown renderer writes this tag
 * into the HTML and chart-element.js registers it, so it lives here rather than
 * as a literal in two places that could drift.
 */
export const CHART_TAG = 'app-echart';

/** The fence language that becomes a chart. The renderer and the build agree through this. */
export const CHART_LANG = 'echarts';

/**
 * The series types an option draws with. `series` may be one object or many,
 * so both shapes collapse here rather than at each call site -- the build uses
 * this to census a corpus, and the element uses it to check a fence against
 * what its ECharts build was made with.
 */
export function seriesTypesOf(option) {
  const types = [option?.series].flat().filter(Boolean).map((s) => s?.type);
  return [...new Set(types.filter(Boolean))];
}

// Charts sit in a prose column, so their content should start where the text
// does -- the 15% default leaves them visibly indented against the paragraphs
// above. `grid` is the plot area and axis labels fall outside it, so
// containLabel folds the labels into the 0 instead of letting them hang.
// `right` is left at its 10% default; this is about aligning the left edge.
//
// The name says prose on purpose: a page that is not a prose column -- a
// dashboard, say -- wants its own grid, not this one.
//
// ECharts 6 treats containLabel as legacy: it does nothing unless the chart
// provider registers LegacyGridContainLabel.
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
    // For an option built from data the site did not write, set <app-echart>'s
    // `option` property instead and nothing is evaluated.
    return Function(`"use strict"; return (${src});`)();
  }
}
