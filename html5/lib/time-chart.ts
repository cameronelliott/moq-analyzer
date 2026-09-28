// A line chart over a capture's seconds, for any per-second series.
//
// A run is hundreds of seconds of one-second points, too dense to read whole,
// so the chart opens on its first tenth and the slider moves the window.
// Legend at the top, slider at the bottom, and the grid clear of both.

import type { EChartsOption, LineSeriesOption } from 'echarts';

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
    data: [...rows].sort((a, b) => a.t_s - b.t_s).map((r) => [r.t_s, value(r)]),
  };
}

export function timeChart(yName: string, series: LineSeriesOption[]): EChartsOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { top: 56, bottom: 56 },
    xAxis: { type: 'value', name: 's' },
    yAxis: { type: 'value', name: yName },
    dataZoom: [{ type: 'slider', bottom: 8, start: 0, end: 10 }, { type: 'inside', start: 0, end: 10 }],
    series,
  };
}
