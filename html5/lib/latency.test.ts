import { expect, test } from 'bun:test';
import type { Leg, LegNo, LegSummaryRow, RecoveryRow } from 'mlog-sql';
import { latency } from './latency';

const LEGS: [LegNo, Leg][] = [[1, 'pub -> relay'], [2, 'relay dwell'], [3, 'relay -> sub']];

const rows = (sub: string, means: [number, number, number]): LegSummaryRow[] =>
  LEGS.map(([leg_no, leg], i) => ({
    sub_cid: sub, leg_no, leg, n: 100, mean_ms: means[i] ?? 0, median_ms: (means[i] ?? 0) / 2, p95_ms: 9,
  }));

const data = [...rows('aaaaaaaa1111', [75, 0.4, 55.8]), ...rows('bbbbbbbb2222', [75.1, 0.5, 98.1])];

test('the page is the markdown, with every block filled', () => {
  const { text } = latency(data).html;
  expect(text).toContain('<h1>Object latency</h1>');
  // The recovery block is empty by design when every trace logged its clock.
  expect(text).toContain('<div data-block="recovery"></div>');
  expect(text.replace('<div data-block="recovery"></div>', '')).not.toMatch(/data-block="[^"]+"><\/div>/);
});

test('a stock capture gets the recovery notice, and dashes for the network legs', () => {
  const recovery: RecoveryRow[] = [{
    cid: 'aaaaaaaa1111', trace: 'a_server.mlog', vantage_point: 'server',
    stream_ids: 'recovered', stream_ids_uncertain: 0, stream_ids_unresolved: 0,
    reference_time: 'recovered', clock_matched: 1545, clock_near_floor: 12,
  }];
  const dwellOnly = rows('aaaaaaaa1111', [0, 0.4, 0]).filter((r) => r.leg_no === 2);
  const { text } = latency(dwellOnly, recovery).html;
  expect(text).toContain('<div data-block="recovery"><wa-callout variant="neutral">');
  expect(text).toContain('lower than actual');
  expect(text).toContain('<td>aaaaaaaa</td><td class="num">—</td><td class="num">0.4</td>'
    + '<td class="num">—</td><td class="num">—</td>');
});

test('leg means table: one row per subscriber, end to end is the sum of the means', () => {
  const { text } = latency(data).html;
  expect(text).toContain('<td>aaaaaaaa</td>');
  expect(text).toContain('<td class="num">131.2</td>');   // 75 + 0.4 + 55.8
  expect(text).toContain('<td class="num">173.7</td>');   // 75.1 + 0.5 + 98.1
});

test('charts: stacked leg means, and dwell median against mean, one bar per subscriber', () => {
  const { charts } = latency(data);
  expect(Object.keys(charts).sort()).toEqual(['dwell', 'leg-means']);
  expect(charts['leg-means']?.series).toEqual([
    expect.objectContaining({ name: 'pub -> relay', stack: 'leg', data: [75, 75.1] }),
    expect.objectContaining({ name: 'relay dwell', stack: 'leg', data: [0.4, 0.5] }),
    expect.objectContaining({ name: 'relay -> sub', stack: 'leg', data: [55.8, 98.1] }),
  ]);
  expect(charts.dwell?.series).toEqual([
    expect.objectContaining({ name: 'median', data: [0.2, 0.25] }),
    expect.objectContaining({ name: 'mean', data: [0.4, 0.5] }),
  ]);
});
