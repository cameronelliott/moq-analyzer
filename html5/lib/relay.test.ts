import { expect, test } from 'bun:test';
import type { RelaySeries, RelaySeriesRow } from 'mlog-sql';
import { relay } from './relay';

const dot = (series: RelaySeries, t_s: number, mean_ms: number, sub_cid: string | null = null): RelaySeriesRow =>
  ({ series, sub_cid, t_s, n: 30, mean_ms });

const rows: RelaySeriesRow[] = [
  dot('relay dwell', 1, 0.4), dot('relay dwell', 0, 0.3),
  dot('relay egress jitter', 0, 0.08),
  dot('subscriber jitter', 0, 0.12, 'bbbbbbbb2222'),
  dot('subscriber jitter', 0, 0.10, 'aaaaaaaa1111'), dot('subscriber jitter', 1, 0.11, 'aaaaaaaa1111'),
];

test('one chart, dots only: dwell on the left axis, the jitters on the right', () => {
  const option = relay(rows).charts['relay-series'];
  expect(option?.series).toEqual([
    expect.objectContaining({ name: 'relay dwell', type: 'scatter', yAxisIndex: 0, data: [[0, 0.3], [1, 0.4]] }),
    expect.objectContaining({ name: 'relay egress jitter', type: 'scatter', yAxisIndex: 1, data: [[0, 0.08]] }),
    expect.objectContaining({ name: 'aaaaaaaa', type: 'scatter', yAxisIndex: 1, data: [[0, 0.1], [1, 0.11]] }),
    expect.objectContaining({ name: 'bbbbbbbb', type: 'scatter', yAxisIndex: 1, data: [[0, 0.12]] }),
  ]);
  // Both axes are ms, at two scales, so each names what it shows.
  expect(option?.yAxis).toEqual([
    expect.objectContaining({ name: 'relay dwell, ms' }),
    expect.objectContaining({ name: 'delay variation, ms' }),
  ]);
  expect(JSON.stringify(option)).not.toContain('"line"');
});

test('the right axis has its own zoom slider, so a few spikes cannot flatten the rest', () => {
  const option = relay(rows).charts['relay-series'];
  expect(option?.dataZoom).toContainEqual(expect.objectContaining({ type: 'slider', yAxisIndex: 1 }));
});

test('relay logs only: no subscriber series, and the page says why', () => {
  const view = relay(rows.filter((r) => r.series !== 'subscriber jitter'));
  expect(view.charts['relay-series']?.series).toHaveLength(2);
  expect(view.html.text).toContain('No subscriber logs are loaded');
});

test('with subscriber jitter, no note', () => {
  expect(relay(rows).html.text).not.toContain('No subscriber logs are loaded');
});
