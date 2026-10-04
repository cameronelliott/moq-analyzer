// The Latency view: pages/latency.md, with its charts and tables from
// legSummary(). Ported from ../html3/md/captures/real-6pop/latency.md, whose
// numbers were dummy data.

import type { EChartsOption } from 'echarts';
import type { LegNo, LegSummaryRow, RecoveryRow } from 'mlog-sql';
import page from '../pages/latency.md' with { type: 'text' };
import { ms, shortCid as label } from './format';
import { html, type SafeHtml } from './html';
import { fillBlocks, markdown } from './markdown';
import { recoveryNotice } from './recovery';
import { legSummaryTable } from './tables';
import type { View } from './view';

const PAGE = markdown(page);

const LEGS: readonly [LegNo, string][] = [[1, 'pub -> relay'], [2, 'relay dwell'], [3, 'relay -> sub']];

export function latency(rows: readonly LegSummaryRow[], recovery: readonly RecoveryRow[] = []): View {
  const subs = [...new Set(rows.map((r) => r.sub_cid))].sort();
  const row = (sub: string, leg: LegNo) => rows.find((r) => r.sub_cid === sub && r.leg_no === leg);
  const mean = (sub: string, leg: LegNo) => row(sub, leg)?.mean_ms ?? null;
  const cell = (n: number | null) => html`<td class="num">${n === null ? '—' : ms(n)}</td>`;

  const endToEnd = (sub: string) => {
    const means = LEGS.map(([leg]) => mean(sub, leg));
    return means.some((m) => m === null) ? null : means.reduce<number>((a, m) => a + (m ?? 0), 0);
  };

  const legMeansTable: SafeHtml = html`<div class="table-scroll"><table>
<thead><tr><th>subscriber</th>${LEGS.map(([, name]) => html`<th class="num">${name}</th>`)}<th class="num">end to end</th></tr></thead>
<tbody>${subs.map((sub) => html`<tr><td>${label(sub)}</td>${LEGS.map(([leg]) => cell(mean(sub, leg)))}${cell(endToEnd(sub))}</tr>`)}</tbody>
</table></div>`;

  const legMeans: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: {},
    xAxis: { type: 'value', name: 'ms' },
    yAxis: { type: 'category', data: subs.map(label) },
    series: LEGS.map(([leg, name]) => ({
      name, type: 'bar', stack: 'leg', data: subs.map((sub) => mean(sub, leg)),
    })),
  };

  const dwell: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: {},
    xAxis: { type: 'category', data: subs.map(label) },
    yAxis: { type: 'value', name: 'ms' },
    series: [
      { name: 'median', type: 'bar', data: subs.map((sub) => row(sub, 2)?.median_ms ?? null) },
      { name: 'mean', type: 'bar', data: subs.map((sub) => mean(sub, 2)) },
    ],
  };

  return {
    html: fillBlocks(PAGE, {
      recovery: recoveryNotice(recovery),
      'leg-means-table': legMeansTable,
      'leg-table': legSummaryTable(rows),
    }),
    charts: { 'leg-means': legMeans, dwell },
  };
}
