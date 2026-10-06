// A chart over a capture's seconds, for any per-second series, as lines or
// dots.
//
// A long run is hundreds of seconds of one-second points, too dense to read
// whole, so the chart opens on its start and the slider moves the window.
// Legend at the top, slider at the bottom, and the grid clear of both.

import type { EChartsOption, LineSeriesOption, ScatterSeriesOption } from 'echarts';

type TimeSeries = LineSeriesOption | ScatterSeriesOption;

const byTime = <R extends { readonly t_s: number }>(rows: readonly R[], value: (r: R) => number) =>
  [...rows].sort((a, b) => a.t_s - b.t_s).map((r) => [r.t_s, value(r)]);

/** One line from rows that each have a second and a value. */
export function line<R extends { readonly t_s: number }>(
  name: string,
  rows: readonly R[],
  value: (r: R) => number,
): LineSeriesOption {
  return {
    name,
    type: 'line',
    showSymbol: false,
    sampling: 'lttb',
    data: byTime(rows, value),
  };
}

/** One dot per row. yAxisIndex 1 is the right-hand axis of a two-axis chart. */
export function dots<R extends { readonly t_s: number }>(
  name: string,
  rows: readonly R[],
  value: (r: R) => number,
  yAxisIndex: 0 | 1 = 0,
): ScatterSeriesOption {
  return { name, type: 'scatter', symbolSize: 4, yAxisIndex, data: byTime(rows, value) };
}

/** A run this long or shorter opens whole. */
const WHOLE_S = 120;
/** A longer run opens on this much of its start. */
const OPENING_S = 60;

/**
 * The percent of a run of `spanS` seconds that the chart opens on. A short
 * run opens whole: a tenth of a 20 s stock sample was two seconds. A long run
 * opens on its first minute, and never on less than a tenth.
 */
export function openingWindow(spanS: number): number {
  if (spanS <= WHOLE_S) return 100;
  return Math.max(10, (100 * OPENING_S) / spanS);
}

/** The seconds from the first point of any series to the last. */
function span(series: readonly TimeSeries[]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    // ECharts also takes a typed array here, so index it: it has no iterator
    const data: ArrayLike<unknown> = s.data ?? [];
    for (let i = 0; i < data.length; i++) {
      // line() and dots() write every point as [second, value]
      const point = data[i];
      const t: unknown = Array.isArray(point) ? point[0] : undefined;
      if (typeof t !== 'number') continue;
      min = Math.min(min, t);
      max = Math.max(max, t);
    }
  }
  return max >= min ? max - min : 0;
}

/**
 * `yName` is one axis name, or two for a left and a right axis. The right
 * axis draws no grid lines: two sets at two scales would not line up.
 *
 * The right axis also gets its own zoom slider, at the right edge. Its series
 * are the ones that mix scales -- on real-6pop, a few 1 ms subscriber spikes
 * against 0.02 ms of relay jitter -- and zooming hides nothing, where capping
 * the axis would pin the spikes to its edge. Dots outside the window are
 * clipped rather than filtered, so the time axis keeps its range.
 */
export function timeChart(yName: string | readonly [string, string], series: TimeSeries[]): EChartsOption {
  const two = typeof yName !== 'string';
  const yAxis = two
    ? [
        { type: 'value' as const, name: yName[0] },
        { type: 'value' as const, name: yName[1], splitLine: { show: false } },
      ]
    : { type: 'value' as const, name: yName };
  const end = openingWindow(span(series));
  const timeZoom = [{ type: 'slider' as const, bottom: 8, start: 0, end }, { type: 'inside' as const, start: 0, end }];
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: two ? { top: 56, bottom: 56, right: 72 } : { top: 56, bottom: 56 },
    xAxis: { type: 'value', name: 's' },
    yAxis,
    dataZoom: two
      ? [...timeZoom, { type: 'slider', yAxisIndex: 1, right: 8, width: 20, filterMode: 'none' }]
      : timeZoom,
    series,
  };
}
