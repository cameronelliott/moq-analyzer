import { expect, test } from 'bun:test';
import type { Distribution, Measure, TrustRow } from 'mlog-sql';
import { distributionCard, histogramOption, overview, type OverviewData } from './overview';

const dist = (measure: Measure, over: Partial<Distribution> = {}): Distribution => ({
  measure,
  unit: measure === 'bitrate' ? 'kbit/s' : 'ms',
  measured_at: measure === 'relay dwell' ? 'relay' : 'subscriber',
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

test("bitrate and interarrival measured at the relay say so; the subscribers' own do not", () => {
  const own = overview(data()).html.text;
  expect(own).not.toContain('Relay output rate only.');
  expect(own).not.toContain('Gaps at the relay');
  const { text } = overview(data({
    distributions: {
      ...data().distributions,
      bitrate: dist('bitrate', { measured_at: 'relay' }),
      interarrival: dist('interarrival', { measured_at: 'relay' }),
    },
  })).html;
  // Relay dwell is always the relay's, and needs no such line: each shows once.
  expect(text.match(/Relay output rate only\./g)?.length).toBe(1);
  expect(text.match(/Gaps at the relay, on objects from the publisher\./g)?.length).toBe(1);
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
  expect(html.text).toContain('Not available: missing pub or sub data.');
  expect(Object.keys(charts).length).toBe(3);
});

test('delivery sums every connection', () => {
  const { text } = overview(data()).html;
  expect(text).toContain('2 lost</span>');
  expect(text).toContain('of 200 objects sent on 2 connections');
  expect(text).toContain('<li><span class="dot success"></span>Joined<span>194</span></li>');
});

// The relay's side of a connection, with the far end not loaded.
const oneEnd = (cid: string) => trust({
  cid, received: 0, joined: null, lost: null, outside_window: null, negative_hops: null,
});

test('delivery with no connection measured says so, and claims no loss', () => {
  const { text } = overview(data({ trust: [oneEnd('c'), oneEnd('d')] })).html;
  expect(text).toContain('Not available: missing pub or sub data.');
  expect(text).not.toContain(' lost</span>');
  expect(text).not.toContain('class="bar"');
});

test('delivery sums only the connections it can measure, and counts the rest', () => {
  const { text } = overview(data({ trust: [trust(), oneEnd('d')] })).html;
  expect(text).toContain('1 lost</span>');
  expect(text).toContain('of 100 objects sent on 1 connection');
  expect(text).toContain('1 more connection could not be measured');
});

test('clocks and hops joined with no connection measured are dashes', () => {
  const { text } = overview(data({ trust: [oneEnd('c')] })).html;
  expect(text).toContain('<dt class="wa-caption-m">Hops joined</dt><dd class="wa-heading-xl">—</dd>');
  expect(text).not.toContain('is not present');
  expect(text).toContain('Clock check unavailable.');
});

test('clocks: the no-clock-error sentence only when there are no negative hops', () => {
  expect(overview(data()).html.text).toContain('Clock-error > transit-time is not present.');
  const bad = overview(data({ trust: [trust({ negative_hops: 3 })] })).html.text;
  expect(bad).toContain('3</span>');
  expect(bad).not.toContain('is not present');
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
