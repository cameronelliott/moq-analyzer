import { test, expect } from 'bun:test';
import { renderChart } from './chart-ssr.js';

const LINE = new Set(['line']);
const BODY = `{
  xAxis: { type: 'category', data: ['a', 'b'] },
  yAxis: {},
  series: [{ type: 'line', data: [1, 2] }],
}`;

test('a prose chart is drawn column width and names no variant', () => {
  const html = renderChart(BODY, '300px', LINE);
  expect(html).toContain('viewBox="0 0 720 300"');
  expect(html).not.toContain('variant=');
});

test('a card chart is drawn card width and tells the element its variant', () => {
  const html = renderChart(BODY, '150px', LINE, 'card');
  expect(html).toContain('viewBox="0 0 360 150"');
  expect(html).toContain('variant="card"');
});

test('an unknown variant stops the build', () => {
  expect(() => renderChart(BODY, '150px', LINE, 'bogus')).toThrow('bogus');
});
