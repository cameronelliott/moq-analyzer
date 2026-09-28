import { expect, test } from 'bun:test';
import type { LegSummaryRow, TrustRow } from 'mlog-sql';
import { legSummaryTable, trustTable } from './tables';

const trust: TrustRow = {
  cid: '<b>x</b>',
  sender_is: null,
  sent: 12345,
  received: 12000,
  joined: 11999,
  lost: 1,
  outside_window: 0,
  negative_hops: 0,
};

const leg: LegSummaryRow = {
  sub_cid: 's1',
  leg_no: 2,
  leg: 'relay dwell',
  n: 1000,
  mean_ms: 1.234,
  median_ms: 1,
  p95_ms: 12.06,
};

// Each <tr> has as many cells as the header has columns.
const cellCounts = (text: string) =>
  [...text.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => (m[1]?.match(/<t[hd][ >]/g) ?? []).length);

test('trust: cid escaped, counts grouped, NULL shown as a dash', () => {
  const { text } = trustTable([trust]);
  expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
  expect(text).not.toContain('<b>x');
  expect(text).toContain('12,345');
  expect(text).toContain('<td>—</td>');
  expect(new Set(cellCounts(text))).toEqual(new Set([8]));
});

test('legs: ms to one decimal', () => {
  const { text } = legSummaryTable([leg]);
  expect(text).toContain('<td class="num">1.2</td>');
  expect(text).toContain('<td class="num">12.1</td>');
  expect(text).toContain('relay dwell');
  expect(new Set(cellCounts(text))).toEqual(new Set([6]));
});

test('no rows: a note, not an empty table', () => {
  expect(trustTable([]).text).not.toContain('<table');
  expect(legSummaryTable([]).text).not.toContain('<table');
});
