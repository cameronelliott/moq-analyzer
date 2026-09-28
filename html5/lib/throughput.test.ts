import { expect, test } from 'bun:test';
import type { ObjectBitrateSeriesRow, ObjectBitrateSummaryRow } from 'mlog-sql';
import { throughput } from './throughput';

type Key = Pick<ObjectBitrateSeriesRow, 'cid' | 'vantage_point' | 'direction' | 'scope' | 'track_namespace' | 'track_name'>;

const PUB: Key = { cid: 'pub00000aaaa', vantage_point: 'client', direction: 'created', scope: 'all', track_namespace: null, track_name: null };
const SUB: Key = { cid: 'sub00000bbbb', vantage_point: 'client', direction: 'parsed', scope: 'all', track_namespace: null, track_name: null };
const SUB_VIDEO: Key = { ...SUB, scope: 'track', track_namespace: '/bbb', track_name: '1.m4s' };
const SUB_INIT: Key = { ...SUB, scope: 'track', track_namespace: '/bbb', track_name: '0.mp4' };
const RELAY: Key = { cid: 'sub00000bbbb', vantage_point: 'server', direction: 'created', scope: 'all', track_namespace: null, track_name: null };

const point = (key: Key, t_s: number, kbit_s: number): ObjectBitrateSeriesRow =>
  ({ ...key, t_s, objects: 1, bytes: kbit_s * 125, kbit_s });

const series = [
  point(PUB, 1, 300), point(PUB, 2, 310),
  point(SUB, 1, 290), point(SUB, 2, 305),
  point(SUB_VIDEO, 1, 200), point(SUB_VIDEO, 2, 210),
  point(SUB_INIT, 1, 10),
  point(RELAY, 1, 999),
];

const summary = (key: Key, mean: number | null): ObjectBitrateSummaryRow => ({
  ...key, bytes: 1000, seconds: 10, span_s: 12,
  mean_kbit_s: mean, p5_kbit_s: mean, median_kbit_s: mean, p95_kbit_s: mean, max_kbit_s: mean,
});

test('received chart: one line per subscriber, and the publisher, from the client ends only', () => {
  const { charts } = throughput(series, []);
  expect(charts.received?.series).toEqual([
    expect.objectContaining({ name: 'publisher pub00000 sent', data: [[1, 300], [2, 310]] }),
    expect.objectContaining({ name: 'sub00000 received', data: [[1, 290], [2, 305]] }),
  ]);
});

test('tracks chart: one line per track at the first subscriber; a one-second track (an init segment) is no line', () => {
  const { charts } = throughput(series, []);
  expect(charts.tracks?.series).toEqual([
    expect.objectContaining({ name: '/bbb/1.m4s', data: [[1, 200], [2, 210]] }),
  ]);
});

test('summary table: client ends, all and each track, NULL as a dash', () => {
  const { text } = throughput(series, [
    summary(PUB, 334.4), summary(SUB, 333.2), summary(SUB_VIDEO, null), summary(RELAY, 1),
  ]).html;
  expect(text).toContain('<td>pub00000</td><td>sent</td><td>all</td><td class="num">334</td>');
  expect(text).toContain('<td>sub00000</td><td>received</td><td>/bbb/1.m4s</td><td class="num">—</td>');
  expect(text).not.toContain('<td class="num">1</td>');   // the relay end is left out
  // A connection's all row comes before its tracks.
  expect(text.indexOf('<td>received</td><td>all</td>'))
    .toBeLessThan(text.indexOf('<td>received</td><td>/bbb/1.m4s</td>'));
});
