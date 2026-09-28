import { expect, test } from 'bun:test';
import type { JitterSeriesRow, JitterSummaryRow, Leg, LegNo } from 'mlog-sql';
import { jitter } from './jitter';

const LEGS: [LegNo, Leg][] = [[1, 'pub -> relay'], [2, 'relay dwell'], [3, 'relay -> sub']];

const summary = (sub: string, means: [number, number, number]): JitterSummaryRow[] =>
  LEGS.map(([leg_no, leg], i) => ({
    sub_cid: sub, leg_no, leg, n: 100, mean_ms: means[i] ?? 0, p95_ms: 5, p99_ms: 9, max_ms: 20,
  }));

const point = (sub: string, leg_no: LegNo, t_s: number, mean_ms: number): JitterSeriesRow => ({
  sub_cid: sub, leg_no, leg: LEGS[leg_no - 1]?.[1] ?? 'pub -> relay', t_s, n: 30, mean_ms, max_ms: mean_ms * 2,
});

const sums = [...summary('aaaaaaaa1111', [1.5, 0.2, 2.5]), ...summary('bbbbbbbb2222', [1.6, 0.3, 4.5])];
const series = [
  point('aaaaaaaa1111', 3, 2, 2.4), point('aaaaaaaa1111', 3, 1, 2.6),
  point('bbbbbbbb2222', 3, 1, 4.4),
  point('aaaaaaaa1111', 1, 1, 1.5),   // another leg: not on the time chart
];

test('per-leg chart: one bar group per subscriber, one series per leg, not stacked', () => {
  const option = jitter(sums, series).charts['leg-means'];
  expect(option?.series).toEqual([
    expect.objectContaining({ name: 'pub -> relay', data: [1.5, 1.6] }),
    expect.objectContaining({ name: 'relay dwell', data: [0.2, 0.3] }),
    expect.objectContaining({ name: 'relay -> sub', data: [2.5, 4.5] }),
  ]);
  expect(JSON.stringify(option)).not.toContain('stack');
});

test('time chart: the relay -> sub leg, one line per subscriber, in time order', () => {
  expect(jitter(sums, series).charts.series?.series).toEqual([
    expect.objectContaining({ name: 'aaaaaaaa', data: [[1, 2.6], [2, 2.4]] }),
    expect.objectContaining({ name: 'bbbbbbbb', data: [[1, 4.4]] }),
  ]);
});

test('summary table: a row per subscriber and leg, in significant digits', () => {
  const { text } = jitter(sums, series).html;
  expect(text).toContain('<td>bbbbbbbb</td><td>relay -&gt; sub</td><td class="num">100</td><td class="num">4.5</td>'
    + '<td class="num">5</td><td class="num">9</td><td class="num">20</td>');
  // A sub-0.15 ms mean keeps its digits.
  expect(text).toContain('<td class="num">0.2</td>');
});

test('small means stay distinct', () => {
  const small = summary('cccccccc3333', [0.0712, 0.0864, 0.1143]);
  const { text } = jitter(small, []).html;
  expect(text).toContain('<td class="num">0.0712</td>');
  expect(text).toContain('<td class="num">0.114</td>');
});
