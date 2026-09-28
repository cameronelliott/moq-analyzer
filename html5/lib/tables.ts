// mlog-sql rows as HTML tables. Plain functions of their rows, so the same
// code can write a static page later.

import type { LegSummaryRow, TrustRow } from 'mlog-sql';
import { count, ms, shortCid } from './format';
import { html, type SafeHtml } from './html';

const num = (text: string) => html`<td class="num">${text}</td>`;
const none = (message: string) => html`<p class="quiet">${message}</p>`;

export function trustTable(rows: readonly TrustRow[]): SafeHtml {
  if (rows.length === 0) return none('No connections.');
  return html`<div class="table-scroll"><table>
<thead><tr><th>cid</th><th>sender is</th><th class="num">sent</th><th class="num">received</th><th class="num">joined</th><th class="num">lost</th><th class="num">outside window</th><th class="num">negative hops</th></tr></thead>
<tbody>${rows.map((r) => html`<tr><td>${r.cid}</td><td>${r.sender_is ?? '—'}</td>${[
    r.sent, r.received, r.joined, r.lost, r.outside_window, r.negative_hops,
  ].map((n) => num(count(n)))}</tr>`)}</tbody>
</table></div>`;
}

export function legSummaryTable(rows: readonly LegSummaryRow[]): SafeHtml {
  if (rows.length === 0) return none('No objects joined across legs.');
  return html`<div class="table-scroll"><table>
<thead><tr><th>subscriber</th><th>leg</th><th class="num">n</th><th class="num">mean ms</th><th class="num">median ms</th><th class="num">p95 ms</th></tr></thead>
<tbody>${rows.map((r) => html`<tr><td>${shortCid(r.sub_cid)}</td><td>${r.leg}</td>${num(count(r.n))}${[
    r.mean_ms, r.median_ms, r.p95_ms,
  ].map((n) => num(ms(n)))}</tr>`)}</tbody>
</table></div>`;
}
