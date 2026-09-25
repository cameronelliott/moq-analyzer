// Number formatting shared by model.ts and blocks.ts, so the showcase build
// and the analyzer print the same digits. Fixed locale on purpose: a page's
// text must not depend on where it was built or viewed.

import { EMPTY_FIELD } from "./fields";

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const fmtCount = (n: number): string => COUNT.format(n);

export const fmtMs = (ms: number): string => ms.toFixed(2);

/** "75.90" when every value rounds the same, "75.89–75.91" otherwise. */
export function fmtMsRange(values: readonly number[]): string {
    if (values.length === 0) return EMPTY_FIELD;
    const lo = fmtMs(Math.min(...values));
    const hi = fmtMs(Math.max(...values));
    return lo === hi ? lo : `${lo}–${hi}`;
}
