import { expect, test, describe } from 'bun:test';

import {
  PROSE_GRID,
  parseChartOption,
  seriesTypesOf,
  withDefaults,
} from './chart-option.js';

describe('parseChartOption', () => {
  test('strict JSON', () => {
    expect(parseChartOption('{"series": [{"type": "line"}]}'))
      .toEqual({ series: [{ type: 'line' }] });
  });

  test('a JS object literal: unquoted keys, trailing comma, comment', () => {
    const src = `{
      title: { text: 'hi' },   // a comment
      series: [{ type: 'bar' },],
    }`;
    expect(parseChartOption(src)).toEqual({ title: { text: 'hi' }, series: [{ type: 'bar' }] });
  });

  test('a fence may generate its data', () => {
    const option = parseChartOption("{ series: [{ type: 'line', data: Array.from({length: 4}, (_, i) => i * 2) }] }");
    expect(option.series[0].data).toEqual([0, 2, 4, 6]);
  });

  test('throws when neither dialect parses', () => {
    expect(() => parseChartOption('{ this is not valid in any dialect ]]'))
      .toThrow();
  });

  test('a JSON string that is not an object still parses', () => {
    // JSON.parse succeeds on a bare literal; nothing here promises an object,
    // and seriesTypesOf has to survive it.
    expect(parseChartOption('42')).toBe(42);
  });
});

describe('withDefaults', () => {
  test('adds a transparent background and the prose grid', () => {
    expect(withDefaults({})).toEqual({ backgroundColor: 'transparent', grid: { ...PROSE_GRID } });
  });

  test("the fence's own values win", () => {
    expect(withDefaults({ backgroundColor: '#fff' }).backgroundColor).toBe('#fff');
  });

  test('a grid key of its own does not drop the grid defaults', () => {
    expect(withDefaults({ grid: { top: 40 } }).grid)
      .toEqual({ left: '1%', containLabel: true, top: 40 });
  });

  test('a grid key of its own can override a default', () => {
    expect(withDefaults({ grid: { left: '10%' } }).grid.left).toBe('10%');
  });

  test('an array of grids is merged element by element', () => {
    expect(withDefaults({ grid: [{ top: 1 }, { left: '5%' }] }).grid).toEqual([
      { left: '1%', containLabel: true, top: 1 },
      { left: '5%', containLabel: true },
    ]);
  });
});

describe('seriesTypesOf', () => {
  test('an array of series', () => {
    expect(seriesTypesOf({ series: [{ type: 'line' }, { type: 'bar' }] })).toEqual(['line', 'bar']);
  });

  test('a single series object', () => {
    expect(seriesTypesOf({ series: { type: 'pie' } })).toEqual(['pie']);
  });

  test('duplicates collapse', () => {
    expect(seriesTypesOf({ series: [{ type: 'line' }, { type: 'line' }] })).toEqual(['line']);
  });

  test('no series, or no option at all', () => {
    expect(seriesTypesOf({})).toEqual([]);
    expect(seriesTypesOf(undefined)).toEqual([]);
    expect(seriesTypesOf(42)).toEqual([]);
  });

  test('a series without a type is not counted', () => {
    expect(seriesTypesOf({ series: [{ data: [1] }, { type: 'bar' }] })).toEqual(['bar']);
  });
});
