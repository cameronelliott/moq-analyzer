// The Jitter view: pages/jitter.md, with its charts and table from
// jitterSummary() and jitterSeries(). New in html5: ../html3 had no jitter
// page. mlog-sql's RFC-3550-explained.md says what the measure is. The label
// is "object jitter", as in mlog-sql's MEASURES.md.

import type { EChartsOption } from 'echarts';
import type { JitterSeriesRow, JitterSummaryRow, LegNo } from 'mlog-sql';
import page from '../pages/jitter.md' with { type: 'text' };
import { count, shortCid, sig } from './format';
import { html } from './html';
import { fillBlocks, markdown } from './markdown';
import { line, timeChart } from './time-chart';
import type { View } from './view';

const PAGE = markdown(page);

const LEGS: readonly [LegNo, string][] = [[1, 'pub -> relay'], [2, 'relay dwell'], [3, 'relay -> sub']];

/** The leg the time chart shows: the one that differs between subscribers. */
const LAST_MILE: LegNo = 3;

export function jitter(summary: readonly JitterSummaryRow[], series: readonly JitterSeriesRow[]): View {
  const subs = [...new Set(summary.map((r) => r.sub_cid))].sort();
  const mean = (sub: string, leg: LegNo) =>
    summary.find((r) => r.sub_cid === sub && r.leg_no === leg)?.mean_ms ?? null;

  const legMeans: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: {},
    xAxis: { type: 'category', data: subs.map(shortCid) },
    yAxis: { type: 'value', name: 'ms' },
    series: LEGS.map(([leg, name]) => ({ name, type: 'bar', data: subs.map((sub) => mean(sub, leg)) })),
  };

  const lastMile = series.filter((r) => r.leg_no === LAST_MILE);
  const seriesChart = timeChart('ms', [...new Set(lastMile.map((r) => r.sub_cid))].sort()
    .map((sub) => line(shortCid(sub), lastMile.filter((r) => r.sub_cid === sub), (r) => r.mean_ms)));

  const rows = [...summary].sort((a, b) => a.sub_cid.localeCompare(b.sub_cid) || a.leg_no - b.leg_no);
  // Significant digits, not one decimal: a mean delay variation is often under 0.15 ms,
  // and one decimal would print every subscriber as 0.1.
  const cell = (n: number) => html`<td class="num">${sig(n)}</td>`;
  const summaryTable = html`<div class="table-scroll"><table>
<thead><tr><th>subscriber</th><th>leg</th><th class="num">objects</th><th class="num">mean</th><th class="num">p95</th><th class="num">p99</th><th class="num">max</th></tr></thead>
<tbody>${rows.map((r) => html`<tr><td>${shortCid(r.sub_cid)}</td><td>${r.leg}</td><td class="num">${count(r.n)}</td>${[
    r.mean_ms, r.p95_ms, r.p99_ms, r.max_ms,
  ].map(cell)}</tr>`)}</tbody>
</table></div>`;

  return {
    html: fillBlocks(PAGE, { 'summary-table': summaryTable }),
    charts: { 'leg-means': legMeans, series: seriesChart },
  };
}
