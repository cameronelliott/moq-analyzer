import { expect, test } from 'bun:test';
import type { Distribution, Measure, TrustRow } from 'mlog-sql';
import { distributionCard, histogramOption, overview, type OverviewData } from './overview';

const dist = (measure: Measure, over: Partial<Distribution> = {}): Distribution => ({
  measure,
  unit: measure === 'bitrate' ? 'kbit/s' : 'ms',
  n: 1000,
  min: 1, p1: 2, p5: 3, p50: 50, p95: 95, p99: 99, max: 120,
  bins: [{ lo: 1, hi: 60, count: 600 }, { lo: 60, hi: 120, count: 400 }],
  ...over,
});

const trust = (over: Partial<TrustRow> = {}): TrustRow => ({
  cid: 'c', sender_is: 'server', sent: 100, received: 98, joined: 97,
  lost: 1, outside_window: 2, negative_hops: 0, ...over,
});

const data = (over: Partial<OverviewData> = {}): OverviewData => ({
  traces: 10,
  trust: [trust(), trust({ cid: 'd' })],
  distributions: {
    'end to end': dist('end to end'),
    'relay dwell': dist('relay dwell'),
    interarrival: dist('interarrival'),
    bitrate: dist('bitrate'),
  },
  ...over,
});

test('latency cards lead with p99; bitrate, where low is bad, with p5', () => {
  const { html } = overview(data());
  expect(html.text).toContain('99 ms</span>');
  expect(html.text).toContain('p99 of 1,000 deliveries');
  expect(html.text).toContain('3 kbit/s</span>');
  expect(html.text).toContain('p5 of 1,000 seconds');
});

test('one chart per distribution, keyed by the element that shows it', () => {
  const { html, charts } = overview(data());
  const ids = [...html.text.matchAll(/data-chart="([^"]+)"/g)].map((m) => m[1] ?? '');
  expect(ids.length).toBe(4);
  expect(Object.keys(charts).sort()).toEqual([...ids].sort());
});

test('a measure with no samples says so and draws no chart', () => {
  const { html, charts } = overview(data({
    distributions: { ...data().distributions, interarrival: null },
  }));
  expect(html.text).toContain('No samples in this capture.');
  expect(Object.keys(charts).length).toBe(3);
});

test('delivery sums every connection', () => {
  const { text } = overview(data()).html;
  expect(text).toContain('2 lost</span>');
  expect(text).toContain('of 200 objects sent on 2 connections');
  expect(text).toContain('<li><span class="dot success"></span>Joined<span>194</span></li>');
});

test('clocks: the no-clock-error sentence only when there are no negative hops', () => {
  expect(overview(data()).html.text).toContain('rules out clock error');
  const bad = overview(data({ trust: [trust({ negative_hops: 3 })] })).html.text;
  expect(bad).toContain('3</span>');
  expect(bad).not.toContain('rules out clock error');
});

test('a distribution not yet computed shows a spinner, no chart, and a slot to fill', () => {
  const { html, charts } = overview(data({ distributions: {} }));
  expect(html.text.match(/<wa-spinner/g)?.length).toBe(4);
  expect(html.text).not.toContain('<app-echart');
  expect(charts).toEqual({});
  expect(html.text).toContain('data-card="relay-dwell"');
});

test('a filled card has the same slot, and its chart', () => {
  const card = distributionCard('relay dwell', dist('relay dwell'));
  expect(card.html.text).toContain('data-card="relay-dwell"');
  expect(card.html.text).not.toContain('<wa-spinner');
  expect(Object.keys(card.charts)).toEqual(['relay-dwell']);
  expect(distributionCard('relay dwell', null).charts).toEqual({});
});

test('histogram: one bar per bin, labels from the bin edges', () => {
  const option = histogramOption(dist('end to end'), 'deliveries');
  expect(option.series).toEqual([expect.objectContaining({ type: 'bar', data: [600, 400] })]);
  expect(option.xAxis).toEqual(expect.objectContaining({ data: ['1–60', '60–120'] }));
});

test('histogram: the first x label starts at the plot edge, not centred past it', () => {
  const option = histogramOption(dist('end to end'), 'deliveries');
  expect(option.xAxis).toEqual(expect.objectContaining({
    axisLabel: expect.objectContaining({ alignMinLabel: 'left' }),
  }));
});
