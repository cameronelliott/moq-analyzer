import { expect, test } from 'bun:test';
import { line, openingWindow, timeChart } from './time-chart';

const seconds = (n: number) => Array.from({ length: n + 1 }, (_, t_s) => ({ t_s, v: 1 }));

test('a short run opens whole', () => {
  expect(openingWindow(0)).toBe(100);
  expect(openingWindow(20)).toBe(100);
  expect(openingWindow(120)).toBe(100);
});

test('a long run opens on its first minute, and never on less than a tenth', () => {
  expect(openingWindow(240)).toBe(25);
  expect(openingWindow(600)).toBe(10);
  expect(openingWindow(6000)).toBe(10);
});

test('the chart takes its window from the seconds its series cover', () => {
  const end = (n: number) => {
    const zoom = timeChart('ms', [line('a', seconds(n), (r) => r.v)]).dataZoom;
    return Array.isArray(zoom) ? zoom.map((z) => z.end) : [];
  };
  // a stock moq-rs sample is some 20 s: a tenth of it showed two seconds
  expect(end(20)).toEqual([100, 100]);
  expect(end(240)).toEqual([25, 25]);
  // two series: the span runs from the first second of either to the last
  const two = timeChart('ms', [
    line('a', seconds(100), (r) => r.v),
    line('b', seconds(240).slice(200), (r) => r.v),
  ]).dataZoom;
  expect(Array.isArray(two) ? two[0]?.end : undefined).toBe(25);
});
