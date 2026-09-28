import { expect, test } from 'bun:test';
import type { Leg, LegNo, LegSummaryRow } from 'mlog-sql';
import { latency } from './latency';

const LEGS: [LegNo, Leg][] = [[1, 'pub -> relay'], [2, 'relay dwell'], [3, 'relay -> sub']];

const rows = (sub: string, means: [number, number, number]): LegSummaryRow[] =>
  LEGS.map(([leg_no, leg], i) => ({
    sub_cid: sub, leg_no, leg, n: 100, mean_ms: means[i] ?? 0, median_ms: (means[i] ?? 0) / 2, p95_ms: 9,
  }));

const data = [...rows('aaaaaaaa1111', [75, 0.4, 55.8]), ...rows('bbbbbbbb2222', [75.1, 0.5, 98.1])];

test('the page is the markdown, with every block filled', () => {
  const { text } = latency(data).html;
  expect(text).toContain('<h1>Latency</h1>');
  expect(text).not.toMatch(/data-block="[^"]+"><\/div>/);
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
