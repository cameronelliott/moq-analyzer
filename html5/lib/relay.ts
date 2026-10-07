// The Relay view: pages/relay.md, with one two-axis dot chart from
// relaySeries(). Relay dwell on the left axis; relay egress jitter and each
// subscriber's jitter on the right. All three are ms, at scales too different
// to share an axis.

import type { RecoveryRow, RelaySeriesRow } from 'mlog-sql';
import page from '../pages/relay.md' with { type: 'text' };
import { shortCid } from './format';
import { html } from './html';
import { fillBlocks, markdown } from './markdown';
import { recoveryNotice } from './recovery';
import { dots, timeChart } from './time-chart';
import type { View } from './view';

const PAGE = markdown(page);

export function relay(rows: readonly RelaySeriesRow[], recovery: readonly RecoveryRow[] = []): View {
  const of = (series: RelaySeriesRow['series']) => rows.filter((r) => r.series === series);
  const subscriber = of('subscriber jitter');
  const subs = [...new Set(subscriber.map((r) => r.sub_cid ?? ''))].sort();
  const mean = (r: RelaySeriesRow) => r.mean_ms;

  const chart = timeChart(['relay dwell, ms', 'delay variation, ms'], [
    dots('relay dwell', of('relay dwell'), mean, 0),
    dots('relay egress jitter', of('relay egress jitter'), mean, 1),
    ...subs.map((sub) => dots(shortCid(sub), subscriber.filter((r) => r.sub_cid === sub), mean, 1)),
  ]);

  const note = subscriber.length === 0
    ? html`<p class="quiet">No subscriber logs are loaded, so there is no subscriber jitter.</p>`
    : html``;

  return {
    html: fillBlocks(PAGE, { note: html`${note}${recoveryNotice(recovery)}` }),
    charts: { 'relay-series': chart },
  };
}
