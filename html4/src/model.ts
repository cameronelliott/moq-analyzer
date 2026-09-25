// Manifest + query rows -> PageModel: every {{field}} as display text and
// every {{> block}} as HTML. The one place numbers are chosen and formatted, so
// the showcase build and the analyzer show the same page for the same capture.
//
// buildModel is pure and synchronous, so it tests without duckdb. loadModel is
// the thin async step that asks a Capture for its rows.

import type { Capture, LegSummaryRow, TrustRow } from "mlog-sql";
import { hostsTable, legTable, subscriberLegs, trustTable, type Labeler } from "./blocks";
import { EMPTY_FIELD, type PageModel } from "./fields";
import { fmtCount, fmtMsRange } from "./format";
import type { Manifest } from "./manifest";

export interface CaptureRows {
    readonly legs: readonly LegSummaryRow[];
    readonly trust: readonly TrustRow[];
}

/** A cid's host label from the manifest, else a short form of the cid. */
export function labeler(m: Manifest): Labeler {
    const byCid = new Map<string, string>();
    for (const h of m.hosts) if (h.cid !== null) byCid.set(h.cid, h.label);
    return (cid) => byCid.get(cid) ?? (cid.length > 8 ? `${cid.slice(0, 8)}…` : cid);
}

const labelOf = (m: Manifest, role: "publisher" | "relay") => {
    const labels = m.hosts.filter((h) => h.role === role).map((h) => h.label);
    return labels.length === 0 ? EMPTY_FIELD : labels.join(", ");
};

export function buildModel(m: Manifest, rows: CaptureRows): PageModel {
    const label = labeler(m);
    const subs = subscriberLegs(rows.legs);
    const leg1Medians = rows.legs.filter((r) => r.leg_no === 1).map((r) => r.median_ms);
    const e2eMeans = subs.flatMap((s) => (s.e2eMean === null ? [] : [s.e2eMean]));

    // Objects the publisher sent: the connection whose client end is the sender.
    const published = rows.trust
        .filter((r) => r.sender_is === "client")
        .reduce((n, r) => n + r.sent, 0);

    return {
        fields: {
            title: m.title,
            description: m.description,
            publisher: labelOf(m, "publisher"),
            relay: labelOf(m, "relay"),
            trace_count: fmtCount(m.traces.length),
            connection_count: fmtCount(new Set(m.traces.map((t) => t.cid)).size),
            subscriber_count: fmtCount(subs.length),
            objects_published: fmtCount(published),
            lost_objects: fmtCount(rows.trust.reduce((n, r) => n + r.lost, 0)),
            leg1_median_ms: fmtMsRange(leg1Medians),
            e2e_mean_ms: fmtMsRange(e2eMeans),
        },
        blocks: {
            hosts: hostsTable(m.hosts),
            legs: legTable(rows.legs, label),
            trust: trustTable(rows.trust, label),
        },
    };
}

export async function loadModel(m: Manifest, capture: Capture): Promise<PageModel> {
    return buildModel(m, { legs: await capture.legSummary(), trust: await capture.trust() });
}
