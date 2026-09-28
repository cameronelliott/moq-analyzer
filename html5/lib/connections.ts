// The Connections view: pages/connections.md, with the trust table. Ported from
// ../html3/md/captures/real-6pop/connections.md, whose numbers were dummy data.

import type { TrustRow } from 'mlog-sql';
import page from '../pages/connections.md' with { type: 'text' };
import { fillBlocks, markdown } from './markdown';
import { trustTable } from './tables';
import type { View } from './view';

const PAGE = markdown(page);

export function connections(rows: readonly TrustRow[]): View {
  return { html: fillBlocks(PAGE, { 'trust-table': trustTable(rows) }), charts: {} };
}
