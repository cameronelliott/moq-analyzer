// The one place numbers become text. A fixed locale (en-US), so every browser
// prints the same text.

const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const MS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const SIG = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });
const PERCENT = new Intl.NumberFormat('en-US', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
});

/** A whole number: 12,345. */
export const count = (n: number): string => COUNT.format(n);

/** Milliseconds in a table column: 12.1. */
export const ms = (n: number): string => MS.format(n);

/** Three significant digits: 0.371, 148, 2,010. For headline numbers. */
export const sig = (n: number): string => SIG.format(n);

/** A headline number and its unit: 25 ms. */
export const quantity = (n: number, unit: string): string => `${sig(n)} ${unit}`;

/** A part of a whole: 98.5%. A whole of 0 prints 0.0%. */
export const percent = (part: number, whole: number): string =>
  PERCENT.format(whole === 0 ? 0 : part / whole);
