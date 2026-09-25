// The one list of names markdown may use, shared by the build and the browser.
// {{field}} is a single value, set as text. {{> block}} is structure that
// changes with the data, rendered by a block function. A typo in a markdown
// file fails the build; a typo in code fails tsc.
//
// model.ts fills every name here; blocks.ts renders every block.

import type { SafeHtml } from "./html";

export const FIELDS = [
    "title",
    "description",
    "publisher",
    "relay",
    "trace_count",
    "connection_count",
    "subscriber_count",
    "objects_published",
    "lost_objects",
    "leg1_median_ms",
    "e2e_mean_ms",
] as const;

export const BLOCKS = ["hosts", "legs", "trust"] as const;

export type FieldName = (typeof FIELDS)[number];
export type BlockName = (typeof BLOCKS)[number];

export interface PageModel {
    /** Already formatted for display. Escaped when rendered. */
    readonly fields: Readonly<Record<FieldName, string>>;
    readonly blocks: Readonly<Record<BlockName, SafeHtml>>;
}

const fieldSet: ReadonlySet<string> = new Set(FIELDS);
const blockSet: ReadonlySet<string> = new Set(BLOCKS);

export const isFieldName = (s: string): s is FieldName => fieldSet.has(s);
export const isBlockName = (s: string): s is BlockName => blockSet.has(s);

/** What a field shows before the analyzer has data. */
export const EMPTY_FIELD = "—";
