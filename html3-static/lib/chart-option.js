// Chart options: the names both sides agree on, the page defaults, and the
// option dialects. Copied from ../html/lib.
//
// Imports nothing. The build's SSR and the browser's chart element both need
// these helpers, and a file boundary here is a bundle boundary: nothing the
// build imports rides along into the browser through this file.

/**
 * The element a `{% echart %}` shortcode becomes. The build writes this tag and
 * the chart element registers it, so it lives here rather than as a literal in
 * two places that could drift.
 */
export const CHART_TAG = 'app-echart';

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

/**
 * A tree-shaken ECharts draws nothing for a series type it was not built with,
 * and says nothing about why. Turn that into an error: the build throws it, and
 * the element shows it in place.
 */
export function assertRegistered(option, registered) {
  const unknown = seriesTypesOf(option).filter((t) => !registered.has(t));
  if (unknown.length) {
    throw new Error(
      `series type not in this build: ${unknown.join(', ')}. `
      + `Built with: ${[...registered].join(', ')}.`);
  }
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

// A chart in a dashboard card. The card's title and caption do the legend's and
// the axis names' work, so the plot takes the whole box; ECharts' default grid
// leaves a 150px chart a 17px plot. The small right and bottom margins are for
// what containLabel does not quite contain: the last value on an x axis, and
// the descenders of the labels under it.
//
// The colors are literals because the build draws the same chart with no
// stylesheet to read tokens from: Web Awesome's default blue-50 for what the
// card is about, then gray-60 and gray-80 for what it is compared against.
export const CARD = {
  grid: { left: 0, right: 12, top: 8, bottom: 6, containLabel: true },
  color: ['#0071ec', '#9194a2', '#c7c9d0'],
};

// The same roles on a dark surface. Light grays would outshine the blue there,
// so the comparison steps down to gray-50 and gray-30. The build draws light
// only; this reaches a chart when <app-echart> redraws it on a dark page.
export const CARD_DARK = { color: ['#0071ec', '#717584', '#424554'] };

const VARIANTS = { prose: { grid: PROSE_GRID }, card: CARD };

// Per variant, what changes on a dark page. Prose charts are left to the
// 'dark' ECharts theme, whose default palette reads on both schemes.
const DARK = { card: CARD_DARK };

/**
 * A variant's defaults under the fence's own option, so a fence can always
 * override. Throws on a variant it does not know.
 */
export function withDefaults(option, variant = 'prose', { dark = false } = {}) {
  if (!Object.hasOwn(VARIANTS, variant)) {
    throw new Error(
      `unknown chart variant: ${variant}. Known: ${Object.keys(VARIANTS).join(', ')}.`);
  }
  const { grid, ...defaults } = { ...VARIANTS[variant], ...(dark ? DARK[variant] : undefined) };
  return {
    backgroundColor: 'transparent',
    ...defaults,
    ...option,
    // A shallow spread would drop the grid defaults the moment a fence set any
    // grid key of its own, so merge that one level deliberately.
    grid: Array.isArray(option.grid)
      ? option.grid.map((g) => ({ ...grid, ...g }))
      : { ...grid, ...option.grid },
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
