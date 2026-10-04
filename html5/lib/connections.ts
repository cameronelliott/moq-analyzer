// The Connections view: pages/connections.md, with the trust table and the
// object-loss chart. Ported from ../html3/md/captures/real-6pop/connections.md,
// whose numbers were dummy data.

import type { EChartsOption } from 'echarts';
import type { RecoveryRow, TrustRow } from 'mlog-sql';
import page from '../pages/connections.md' with { type: 'text' };
import { shortCid } from './format';
import { fillBlocks, markdown } from './markdown';
import { recoveryTable } from './recovery';
import { trustTable } from './tables';
import type { View } from './view';

const PAGE = markdown(page);

// Status colors, not series colors: Web Awesome's red-50 for lost, as on the
// Overview's Delivery card, and gray-50 for outside the window, which is not a
// problem. gray-50 rather than the card's gray-60: gray-60 is under 3:1 against
// a light surface.
const LOST = '#dc3146';
const OUTSIDE = '#717584';

/**
 * Only the objects that did not join. Joined is ~99% of every connection, so
 * drawn with it the rest would be slivers; the table has joined.
 */
function notJoined(rows: readonly TrustRow[]): EChartsOption {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: {},
    xAxis: { type: 'value', name: 'objects' },
    // inverse: top to bottom in the table's order, not ECharts' bottom-up.
    yAxis: { type: 'category', inverse: true, data: rows.map((r) => shortCid(r.cid)) },
    series: [
      { name: 'lost', type: 'bar', stack: 'not joined', color: LOST, data: rows.map((r) => r.lost) },
      { name: 'outside the window', type: 'bar', stack: 'not joined', color: OUTSIDE, data: rows.map((r) => r.outside_window) },
    ],
  };
}

export function connections(rows: readonly TrustRow[], recovery: readonly RecoveryRow[] = []): View {
  return {
    html: fillBlocks(PAGE, { 'trust-table': trustTable(rows), 'recovery-table': recoveryTable(recovery) }),
    charts: { 'not-joined': notJoined(rows) },
  };
}
