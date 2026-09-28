import { expect, test } from 'bun:test';
import { count, ms, percent, quantity, sig } from './format';

test('count: whole numbers, en-US grouping', () => {
  expect(count(12345)).toBe('12,345');
  expect(count(0)).toBe('0');
});

test('ms: one decimal', () => {
  expect(ms(1.234)).toBe('1.2');
  expect(ms(12.06)).toBe('12.1');
});

test('sig: three significant digits', () => {
  expect(sig(0.3712)).toBe('0.371');
  expect(sig(148.4)).toBe('148');
  expect(sig(2013.4)).toBe('2,010');
  expect(sig(0)).toBe('0');
});

test('quantity: value and unit', () => {
  expect(quantity(25.04, 'ms')).toBe('25 ms');
  expect(quantity(2013.4, 'kbit/s')).toBe('2,010 kbit/s');
});

test('percent: one decimal, of a whole', () => {
  expect(percent(985, 1000)).toBe('98.5%');
  expect(percent(0, 0)).toBe('0.0%');
});
