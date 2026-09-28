// The Throughput view: pages/throughput.md, with its charts and table from
// objectBitrateSeries() and objectBitrateSummary(). Ported from
// ../html3/md/captures/real-6pop/throughput.md, whose chart was made up.
//
// Only the client ends: the publisher's `created` rate, and each subscriber's
// `parsed` rate. The relay's ends are the same traffic seen from the middle.

import type { ObjectBitrateSeriesRow, ObjectBitrateSummaryRow } from 'mlog-sql';
import page from '../pages/throughput.md' with { type: 'text' };
import { count, shortCid } from './format';
import { html } from './html';
import { fillBlocks, markdown } from './markdown';
import { line as timeLine, timeChart as chartOf } from './time-chart';
import type { View } from './view';

const PAGE = markdown(page);

type Row = ObjectBitrateSeriesRow | ObjectBitrateSummaryRow;

const track = (r: Row) => (r.scope === 'all' ? 'all' : `${r.track_namespace ?? '?'}/${r.track_name ?? '?'}`);
const cids = (rows: readonly Row[]) => [...new Set(rows.map((r) => r.cid))].sort();
const line = (name: string, rows: readonly ObjectBitrateSeriesRow[]) => timeLine(name, rows, (r) => r.kbit_s);
const timeChart = (series: ReturnType<typeof line>[]) => chartOf('kbit/s', series);

export function throughput(
  series: readonly ObjectBitrateSeriesRow[],
  summary: readonly ObjectBitrateSummaryRow[],
): View {
  const client = series.filter((r) => r.vantage_point === 'client');
  const sent = client.filter((r) => r.direction === 'created');
  const received = client.filter((r) => r.direction === 'parsed');
  const all = (rows: readonly ObjectBitrateSeriesRow[], cid: string) =>
    rows.filter((r) => r.cid === cid && r.scope === 'all');

  const receivedChart = timeChart([
    ...cids(sent).map((cid) => line(`publisher ${shortCid(cid)} sent`, all(sent, cid))),
    ...cids(received).map((cid) => line(`${shortCid(cid)} received`, all(received, cid))),
  ]);

  const first = cids(received)[0];
  const firstTracks = received.filter((r) => r.cid === first && r.scope === 'track');
  // A track with one second of data -- an init segment -- is a dot, not a line.
  const tracksChart = timeChart([...new Set(firstTracks.map(track))].sort()
    .map((name) => ({ name, rows: firstTracks.filter((r) => track(r) === name) }))
    .filter(({ rows }) => rows.length > 1)
    .map(({ name, rows }) => line(name, rows)));

  const kbit = (n: number | null) => html`<td class="num">${n === null ? '—' : count(n)}</td>`;
  const rows = summary
    .filter((r) => r.vantage_point === 'client' && (r.scope === 'all' || r.seconds > 0))
    // Each connection's `all` row first, then its tracks.
    .sort((a, b) => a.cid.localeCompare(b.cid)
      || Number(a.scope === 'track') - Number(b.scope === 'track')
      || track(a).localeCompare(track(b)));
  const summaryTable = html`<div class="table-scroll"><table>
<thead><tr><th>connection</th><th>end</th><th>track</th><th class="num">mean</th><th class="num">p5</th><th class="num">median</th><th class="num">p95</th><th class="num">max</th></tr></thead>
<tbody>${rows.map((r) => html`<tr><td>${shortCid(r.cid)}</td><td>${r.direction === 'created' ? 'sent' : 'received'}</td><td>${track(r)}</td>${[
    r.mean_kbit_s, r.p5_kbit_s, r.median_kbit_s, r.p95_kbit_s, r.max_kbit_s,
  ].map(kbit)}</tr>`)}</tbody>
</table></div>`;

  return {
    html: fillBlocks(PAGE, { 'summary-table': summaryTable }),
    charts: { received: receivedChart, tracks: tracksChart },
  };
}
