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

/**
 * A value in a chart tooltip. ECharts prints a number in full, as
 * 0.13505479452054794. This gives three significant digits, and a number of
 * 100 or more as a whole number, so a count keeps every digit. A point prints
 * each of its numbers. `value` is unknown because ECharts passes whatever the
 * series holds.
 */
export function tooltipValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(tooltipValue).join(', ');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    return Math.abs(value) >= 100 ? count(value) : sig(value);
  }
  return value === null || value === undefined ? '—' : String(value);
}

/** A connection by the start of its cid. A manifest will give names later. */
export const shortCid = (cid: string): string => cid.slice(0, 8);

/** A part of a whole: 98.5%. A whole of 0 prints 0.0%. */
export const percent = (part: number, whole: number): string =>
  PERCENT.format(whole === 0 ? 0 : part / whole);
