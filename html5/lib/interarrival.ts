// The Interarrival view: pages/interarrival.md, with one histogram per track
// from distribution('interarrival', track). mlog-sql has no interarrival
// series, so ../html3's per-object line chart (made-up data) did not come over.
//
// The tracks come from the bitrate summary: each track some subscriber
// received for more than an instant.

import type { Distribution, ObjectBitrateSummaryRow, Track } from 'mlog-sql';
import page from '../pages/interarrival.md' with { type: 'text' };
import { count, ms } from './format';
import { html } from './html';
import { fillBlocks, markdown } from './markdown';
import { histogramOption } from './overview';
import type { View } from './view';

const PAGE = markdown(page);

export interface TrackDistribution {
  readonly track: Track;
  /** null when the track has no gaps. */
  readonly d: Distribution | null;
}

const trackName = (t: Track) => `${t.namespace}/${t.name}`;

/** Each track a subscriber received, once, sorted. An init segment (no whole second) is left out. */
export function receivedTracks(summary: readonly ObjectBitrateSummaryRow[]): Track[] {
  const tracks = new Map<string, Track>();
  for (const r of summary) {
    if (r.vantage_point !== 'client' || r.direction !== 'parsed' || r.scope !== 'track' || r.seconds === 0) continue;
    if (r.track_namespace === null || r.track_name === null) continue;
    const track = { namespace: r.track_namespace, name: r.track_name };
    tracks.set(trackName(track), track);
  }
  return [...tracks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, t]) => t);
}

export function interarrival(tracks: readonly TrackDistribution[]): View {
  const charts = Object.fromEntries(tracks.flatMap(({ d }, i) =>
    d ? [[`track-${i}`, histogramOption(d, 'gaps')]] : []));

  // The card variant: a histogram with no axis names needs no room for them.
  const trackCharts = html`${tracks.map(({ track, d }, i) => html`<h3>${trackName(track)}</h3>
${d
    ? html`<app-echart data-chart="track-${i}" variant="card" height="160px"></app-echart>`
    : html`<p>No gaps on this track.</p>`}`)}`;

  const cell = (n: number) => html`<td class="num">${ms(n)}</td>`;
  const trackTable = html`<div class="table-scroll"><table>
<thead><tr><th>track</th><th class="num">gaps</th><th class="num">p50 ms</th><th class="num">p95 ms</th><th class="num">p99 ms</th><th class="num">max ms</th></tr></thead>
<tbody>${tracks.map(({ track, d }) => html`<tr><td>${trackName(track)}</td>${d
    ? html`<td class="num">${count(d.n)}</td>${[d.p50, d.p95, d.p99, d.max].map(cell)}`
    : html`<td class="num">0</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>`}</tr>`)}</tbody>
</table></div>`;

  return {
    html: fillBlocks(PAGE, { 'track-table': trackTable, 'track-charts': trackCharts }),
    charts,
  };
}
