// Holds mlog-sql.d.ts (the public header) and the code to each other. Types
// only, never run: `bun run typecheck` fails when they disagree.
//
// api.ts imports its public types from the header, so those cannot drift. What
// is left: the runtime values, and each row type the header spells out against
// the column spec that produces the rows.
//
// skipLibCheck skips the header's own errors. A header type that no row or
// signature uses is checked by nothing, so every exported type must be used.

import type * as H from "./mlog-sql.d.ts";
import type * as I from "./api";
import type { QUERIES, Row } from "./api-internal";

// Exact equality, readonly and nullability included (assignability is not enough).
type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Rows<K extends keyof typeof QUERIES> = Row<(typeof QUERIES)[K]["columns"]>;

export type HeaderMatchesApi = [
    Expect<Equal<keyof typeof H, keyof typeof I>>,
    Expect<Equal<typeof H.openCapture, typeof I.openCapture>>,
    Expect<Equal<typeof H.CaptureError, typeof I.CaptureError>>,
    Expect<Equal<H.LegSummaryRow, Rows<"legSummary">>>,
    Expect<Equal<H.TrustRow, Rows<"trust">>>,
    Expect<Equal<typeof H.RECOVERED_DWELL, typeof I.RECOVERED_DWELL>>,
    Expect<Equal<H.CoverageRow, Rows<"coverage">>>,
    Expect<Equal<H.RecoveryRow, Rows<"recovery">>>,
    Expect<Equal<H.JitterSummaryRow, Rows<"jitterSummary">>>,
    Expect<Equal<H.JitterSeriesRow, Rows<"jitterSeries">>>,
    Expect<Equal<H.RelaySeriesRow, Rows<"relaySeries">>>,
    Expect<Equal<H.ObjectBitrateSummaryRow, Rows<"objectBitrateSummary">>>,
    Expect<Equal<H.ObjectBitrateSeriesRow, Rows<"objectBitrateSeries">>>,
    // Distribution is assembled in api-internal, not a row, so only the value
    // sets it shares with the views are checked here.
    Expect<Equal<H.Measure, Rows<"distributionSummary">["measure"]>>,
    Expect<Equal<H.Unit, Rows<"distributionSummary">["unit"]>>,
    Expect<Equal<H.MeasuredAt, Rows<"distributionSummary">["measured_at"]>>,
];
