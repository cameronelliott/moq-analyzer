import { expect, test } from 'bun:test';
import type { Distribution, ObjectBitrateSummaryRow } from 'mlog-sql';
import { interarrival, receivedTracks } from './interarrival';

const summary = (over: Partial<ObjectBitrateSummaryRow>): ObjectBitrateSummaryRow => ({
  cid: 'c', vantage_point: 'client', direction: 'parsed', scope: 'track',
  track_namespace: '/bbb', track_name: '1.m4s', bytes: 1, seconds: 10, span_s: 10,
  mean_kbit_s: 1, p5_kbit_s: 1, median_kbit_s: 1, p95_kbit_s: 1, max_kbit_s: 1, ...over,
});

const dist: Distribution = {
  measure: 'interarrival', unit: 'ms', n: 1000,
  min: 0.1, p1: 1, p5: 5, p50: 33.4, p95: 40, p99: 47.3, max: 62.5,
  bins: [{ lo: 0.1, hi: 30, count: 300 }, { lo: 30, hi: 62.5, count: 700 }],
};

test('received tracks: each track a subscriber received, once, sorted; no init segments, no all rows', () => {
  expect(receivedTracks([
    summary({ cid: 'a', track_name: '2.m4s' }),
    summary({ cid: 'b', track_name: '2.m4s' }),
    summary({ cid: 'a', track_name: '1.m4s' }),
    summary({ track_name: '0.mp4', seconds: 0 }),
    summary({ scope: 'all', track_namespace: null, track_name: null }),
    summary({ vantage_point: 'server', direction: 'created', track_name: '9.m4s' }),
  ])).toEqual([{ namespace: '/bbb', name: '1.m4s' }, { namespace: '/bbb', name: '2.m4s' }]);
});

test('one section and one chart per track; a track with no gaps says so', () => {
  const { html, charts } = interarrival([
    { track: { namespace: '/bbb', name: '1.m4s' }, d: dist },
    { track: { namespace: '/bbb', name: '2.m4s' }, d: null },
  ]);
  expect(html.text).toContain('<h3>/bbb/1.m4s</h3>');
  expect(html.text).toContain('<h3>/bbb/2.m4s</h3>');
  expect(html.text).toContain('No gaps on this track.');
  expect(Object.keys(charts)).toEqual(['track-0']);
  expect(html.text).toContain('data-chart="track-0"');
});

test('summary table: one row per track, quantiles in ms', () => {
  const { text } = interarrival([{ track: { namespace: '/bbb', name: '1.m4s' }, d: dist }]).html;
  expect(text).toContain('<td>/bbb/1.m4s</td><td class="num">1,000</td><td class="num">33.4</td>'
    + '<td class="num">40.0</td><td class="num">47.3</td><td class="num">62.5</td>');
});

test('track names from an mlog are escaped', () => {
  const { text } = interarrival([{ track: { namespace: '<i>', name: 'x' }, d: null }]).html;
  expect(text).toContain('&lt;i&gt;/x');
  expect(text).not.toContain('<i>/x');
});
