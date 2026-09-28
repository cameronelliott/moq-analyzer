import { expect, test } from 'bun:test';
import { CARD, CARD_DARK, PROSE_GRID, assertRegistered, seriesTypesOf, withDefaults } from './chart-option';

test('prose is the default variant', () => {
  const option = withDefaults({});
  expect(option.grid).toEqual(PROSE_GRID);
  expect(option.color).toBeUndefined();
});

test('a card takes the card grid and palette', () => {
  const option = withDefaults({}, 'card');
  expect(option.grid).toEqual(CARD.grid);
  expect(option.color).toEqual(CARD.color);
});

test("an option's own keys beat the variant's, grid key by key", () => {
  const option = withDefaults({ color: ['red'], grid: { top: 20 } }, 'card');
  expect(option.color).toEqual(['red']);
  expect(option.grid).toEqual({ ...CARD.grid, top: 20 });
});

test('every grid in an array gets the defaults', () => {
  const option = withDefaults({ grid: [{ top: 1 }, { top: 2 }] }, 'card');
  expect(option.grid).toEqual([{ ...CARD.grid, top: 1 }, { ...CARD.grid, top: 2 }]);
});

test('a card on a dark page takes the dark palette and keeps the card grid', () => {
  const option = withDefaults({}, 'card', { dark: true });
  expect(option.color).toEqual(CARD_DARK.color);
  expect(option.grid).toEqual(CARD.grid);
});

test("an option's own colors beat the dark palette too", () => {
  expect(withDefaults({ color: ['red'] }, 'card', { dark: true }).color).toEqual(['red']);
});

test('prose has no dark palette: the theme handles it', () => {
  expect(withDefaults({}, 'prose', { dark: true })).toEqual(withDefaults({}));
});

test('an unknown variant throws rather than drawing with the wrong defaults', () => {
  expect(() => withDefaults({}, 'bogus')).toThrow('bogus');
  // Inherited keys are not variants.
  expect(() => withDefaults({}, 'toString')).toThrow('toString');
});

test('series types: one series or many, each type once', () => {
  expect(seriesTypesOf({ series: { type: 'bar' } })).toEqual(['bar']);
  expect(seriesTypesOf({ series: [{ type: 'bar' }, { type: 'line' }, { type: 'bar' }] }))
    .toEqual(['bar', 'line']);
  expect(seriesTypesOf({})).toEqual([]);
});

test('a series type the build lacks throws, naming it', () => {
  const registered = new Set(['bar', 'line']);
  expect(() => assertRegistered({ series: [{ type: 'line' }] }, registered)).not.toThrow();
  expect(() => assertRegistered({ series: [{ type: 'pie' }] }, registered)).toThrow('pie');
});
