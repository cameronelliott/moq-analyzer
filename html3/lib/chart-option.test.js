import { test, expect } from 'bun:test';
import { CARD, CARD_DARK, PROSE_GRID, withDefaults } from './chart-option.js';

test('prose is the default variant, as before', () => {
  const option = withDefaults({});
  expect(option.grid).toEqual(PROSE_GRID);
  expect(option.color).toBeUndefined();
});

test('a card takes the card grid and palette', () => {
  const option = withDefaults({}, 'card');
  expect(option.grid).toEqual(CARD.grid);
  expect(option.color).toEqual(CARD.color);
});

test("a fence's own keys beat the variant's, grid key by key", () => {
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

test("a fence's own colors beat the dark palette too", () => {
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
