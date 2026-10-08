// Chart options: the page defaults and the series-type check. From
// ../html3/lib/chart-option.js, less the config-string parser.
//
// Imports types and the number formats only, and touches no DOM: an option in,
// an option out. That keeps it usable at build time if static pages come back.

import type { EChartsOption } from 'echarts';
import { tooltipValue } from './format';

/** The chart element's tag. */
export const CHART_TAG = 'app-echart';

/** The series types an option draws with. `series` may be one object or many. */
export function seriesTypesOf(option: EChartsOption): string[] {
  const series = option.series === undefined ? [] : [option.series].flat();
  return [...new Set(series.flatMap((s) => (s.type ? [s.type] : [])))];
}

/**
 * A tree-shaken ECharts draws nothing for a series type it was not built with,
 * and says nothing about why. Turn that into an error the element shows in
 * place.
 */
export function assertRegistered(option: EChartsOption, registered: ReadonlySet<string>): void {
  const unknown = seriesTypesOf(option).filter((t) => !registered.has(t));
  if (unknown.length) {
    throw new Error(
      `series type not in this build: ${unknown.join(', ')}. `
      + `Built with: ${[...registered].join(', ')}.`);
  }
}

type Grid = Record<string, number | string | boolean>;

// Charts sit in a text column, so their content should start where the text
// does -- the 15% default leaves them visibly indented against the paragraphs
// above. `grid` is the plot area and axis labels fall outside it, so
// containLabel folds the labels into the 0 instead of letting them hang.
//
// ECharts 6 treats containLabel as legacy: it does nothing unless the chart
// provider registers LegacyGridContainLabel.
export const PROSE_GRID: Grid = { left: '1%', containLabel: true };

// A chart in a dashboard card. The card's title and caption do the legend's and
// the axis names' work, so the plot takes the whole box; ECharts' default grid
// leaves a 150px chart a 17px plot. The small right and bottom margins are for
// what containLabel does not quite contain: the last value on an x axis, and
// the descenders of the labels under it.
//
// Web Awesome's default blue-50 for what the card is about, then gray-60 and
// gray-80 for what it is compared against.
export const CARD = {
  grid: { left: 0, right: 12, top: 8, bottom: 6, containLabel: true } satisfies Grid,
  color: ['#0071ec', '#9194a2', '#c7c9d0'],
};

// The same roles on a dark surface. Light grays would outshine the blue there,
// so the comparison steps down to gray-50 and gray-30.
export const CARD_DARK = { color: ['#0071ec', '#717584', '#424554'] };

export type ChartVariant = 'prose' | 'card';

interface Defaults {
  readonly grid: Grid;
  readonly color?: string[];
}

const VARIANTS: Record<ChartVariant, Defaults> = { prose: { grid: PROSE_GRID }, card: CARD };

// Per variant, what changes on a dark page. Prose charts are left to the
// 'dark' ECharts theme, whose default palette reads on both schemes.
const DARK: Partial<Record<ChartVariant, Partial<Defaults>>> = { card: CARD_DARK };

export const isChartVariant = (v: string): v is ChartVariant => Object.hasOwn(VARIANTS, v);

/**
 * A variant's defaults under the option's own keys, so an option can always
 * override. `variant` is a string because it arrives as an HTML attribute;
 * an unknown one throws.
 */
export function withDefaults(
  option: EChartsOption,
  variant: string = 'prose',
  { dark = false } = {},
): EChartsOption {
  if (!isChartVariant(variant)) {
    throw new Error(
      `unknown chart variant: ${variant}. Known: ${Object.keys(VARIANTS).join(', ')}.`);
  }
  const { grid, ...defaults } = { ...VARIANTS[variant], ...(dark ? DARK[variant] : undefined) };
  // ECharts prints a tooltip number in full. Every chart with a tooltip gets
  // the short form, unless its option formats the value itself.
  const tooltip = option.tooltip === undefined || Array.isArray(option.tooltip)
    ? option.tooltip
    : { valueFormatter: tooltipValue, ...option.tooltip };
  return {
    backgroundColor: 'transparent',
    ...defaults,
    ...option,
    ...(tooltip === undefined ? {} : { tooltip }),
    // A shallow spread would drop the grid defaults the moment an option set
    // any grid key of its own, so merge that one level deliberately.
    grid: Array.isArray(option.grid)
      ? option.grid.map((g) => ({ ...grid, ...g }))
      : { ...grid, ...option.grid },
  };
}
