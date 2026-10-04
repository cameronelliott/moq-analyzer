// The Throughput view: pages/throughput.md, with its charts and table from
// objectBitrateSeries() and objectBitrateSummary(). Ported from
// ../html3/md/captures/real-6pop/throughput.md, whose chart was made up.
//
// The client ends: the publisher's `created` rate, and each subscriber's
// `parsed` rate. The relay's ends are the same traffic seen from the middle, so
// they are left out -- except on a connection whose client end is not loaded.
// A relay operator has only the relay's logs, and then the relay's end is what
// there is: what it received from the publisher, and what it sent each
// subscriber. Those lines and rows say `relay`.

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
  const isClient = (r: Row) => r.vantage_point === 'client';
  const withClient = new Set([...series, ...summary].filter(isClient).map((r) => r.cid));
  /** The relay's end of a connection whose client end is not loaded. */
  const relayOnly = (r: Row) => r.vantage_point === 'server' && !withClient.has(r.cid);
  const shown = (r: Row) => isClient(r) || relayOnly(r);
  // The publisher's side of the relay, then the subscribers' side: a client
  // that created, or the relay that parsed; a client that parsed, or the relay
  // that created.
  const fromPublisher = (r: Row) => (r.direction === 'created') === isClient(r);

  const visible = series.filter(shown);
  const sent = visible.filter(fromPublisher);
  const received = visible.filter((r) => !fromPublisher(r));
  const all = (rows: readonly ObjectBitrateSeriesRow[], cid: string) =>
    rows.filter((r) => r.cid === cid && r.scope === 'all');
  const relayEnd = (rows: readonly ObjectBitrateSeriesRow[], cid: string) =>
    rows.some((r) => r.cid === cid && relayOnly(r));

  const receivedChart = timeChart([
    ...cids(sent).map((cid) => line(relayEnd(sent, cid)
      ? `relay received from ${shortCid(cid)}` : `publisher ${shortCid(cid)} sent`, all(sent, cid))),
    ...cids(received).map((cid) => line(relayEnd(received, cid)
      ? `relay sent to ${shortCid(cid)}` : `${shortCid(cid)} received`, all(received, cid))),
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
    .filter((r) => shown(r) && (r.scope === 'all' || r.seconds > 0))
    // Each connection's `all` row first, then its tracks.
    .sort((a, b) => a.cid.localeCompare(b.cid)
      || Number(a.scope === 'track') - Number(b.scope === 'track')
      || track(a).localeCompare(track(b)));
  const summaryTable = html`<div class="table-scroll"><table>
<thead><tr><th>connection</th><th>end</th><th>track</th><th class="num">mean</th><th class="num">p5</th><th class="num">median</th><th class="num">p95</th><th class="num">max</th></tr></thead>
<tbody>${rows.map((r) => html`<tr><td>${shortCid(r.cid)}</td><td>${relayOnly(r) ? 'relay ' : ''}${r.direction === 'created' ? 'sent' : 'received'}</td><td>${track(r)}</td>${[
    r.mean_kbit_s, r.p5_kbit_s, r.median_kbit_s, r.p95_kbit_s, r.max_kbit_s,
  ].map(kbit)}</tr>`)}</tbody>
</table></div>`;

  const note = [...series, ...summary].some(relayOnly)
    ? html`<p class="quiet">Where a connection's far end has no log loaded, the lines and rows marked relay are the relay's end of it: what the relay received from the publisher, and what it sent to each subscriber.</p>`
    : html``;

  return {
    html: fillBlocks(PAGE, { note, 'summary-table': summaryTable }),
    charts: { received: receivedChart, tracks: tracksChart },
  };
}
