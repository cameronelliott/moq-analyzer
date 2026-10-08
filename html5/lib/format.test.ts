import { expect, test } from 'bun:test';
import { count, ms, percent, quantity, sig, tooltipValue } from './format';

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

test('tooltipValue: three significant digits, and whole numbers in full', () => {
  // what a chart tooltip printed before: 0.13505479452054794
  expect(tooltipValue(0.13505479452054794)).toBe('0.135');
  expect(tooltipValue(12.3456)).toBe('12.3');
  expect(tooltipValue(334.449)).toBe('334');
  // a count keeps every digit: three significant digits would print 12,300
  expect(tooltipValue(12345)).toBe('12,345');
  expect(tooltipValue(1234.56)).toBe('1,235');
  expect(tooltipValue(0)).toBe('0');
});

test('tooltipValue: a point prints each number, and other values as they are', () => {
  expect(tooltipValue([3, 0.13505479452054794])).toBe('3, 0.135');
  expect(tooltipValue('sub-1')).toBe('sub-1');
  expect(tooltipValue(null)).toBe('—');
  expect(tooltipValue(undefined)).toBe('—');
  expect(tooltipValue(NaN)).toBe('—');
});
