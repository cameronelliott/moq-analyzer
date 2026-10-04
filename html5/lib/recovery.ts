// What mlog-sql recovered on a stock moq-rs capture, as a notice and a table.
// Plain functions of recovery()'s rows. A capture where every trace logged its
// stream ids and its reference_time has no notice.

import { RECOVERED_DWELL, type RecoveryRow } from 'mlog-sql';
import { count, shortCid } from './format';
import { html, type SafeHtml } from './html';

// The notice text. Cameron rewrites it; keep it all here. The dwell note is
// mlog-sql's RECOVERED_DWELL.note.
const TITLE = 'This capture is from stock moq-rs.';
const NO_NETWORK_LEGS = 'There is no latency for the network legs: a leg between two hosts needs a '
  + 'reference_time in the log of each.';

const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
const sum = (rows: readonly RecoveryRow[], key: 'stream_ids_uncertain' | 'stream_ids_unresolved') =>
  rows.reduce((total, r) => total + (r[key] ?? 0), 0);

/** A recovered time base that one or two objects set by themselves. */
const WEAK = 2;

export function recoveryNotice(rows: readonly RecoveryRow[]): SafeHtml {
  const ids = rows.filter((r) => r.stream_ids === 'recovered');
  const lined = rows.filter((r) => r.reference_time === 'recovered');
  const untimed = rows.filter((r) => r.reference_time !== 'logged');
  if (ids.length === 0 && untimed.length === 0) return html``;

  const uncertain = sum(ids, 'stream_ids_uncertain');
  const unresolved = sum(ids, 'stream_ids_unresolved');
  const weak = lined.filter((r) => r.clock_near_floor !== null && r.clock_near_floor <= WEAK);

  return html`<wa-callout variant="neutral">
  <strong>${TITLE}</strong>
  ${ids.length > 0 ? html`<p>Stream ids were recovered on ${plural(ids.length, 'trace', 'traces')}.${
    uncertain > 0 ? ` ${plural(uncertain, 'object', 'objects')} had a second likely stream.` : ''}${
    unresolved > 0 ? ` ${plural(unresolved, 'object', 'objects')} could not be placed and are in no measure.` : ''}</p>` : null}
  ${lined.length > 0 ? html`<p>${RECOVERED_DWELL.note}</p>` : null}
  ${untimed.length > 0 ? html`<p>${NO_NETWORK_LEGS}</p>` : null}
</wa-callout>${weak.map((r) => html`<wa-callout variant="warning">
  Do not trust relay dwell for ${shortCid(r.cid)}. Its time base rests on ${count(r.clock_near_floor ?? 0)} of ${count(r.clock_matched ?? 0)} objects, so one wrongly matched object could have set it.
</wa-callout>`)}`;
}

export function recoveryTable(rows: readonly RecoveryRow[]): SafeHtml {
  if (rows.length === 0) return html`<p class="quiet">No traces.</p>`;
  const num = (n: number | null) => html`<td class="num">${n === null ? '—' : count(n)}</td>`;
  return html`<div class="table-scroll"><table>
<thead><tr><th>connection</th><th>end</th><th>stream ids</th><th>reference time</th><th class="num">objects matched</th><th class="num">near the fastest</th></tr></thead>
<tbody>${rows.map((r) => html`<tr><td>${shortCid(r.cid)}</td><td>${r.vantage_point ?? '—'}</td><td>${r.stream_ids}</td><td>${r.reference_time}</td>${num(r.clock_matched)}${num(r.clock_near_floor)}</tr>`)}</tbody>
</table></div>`;
}
