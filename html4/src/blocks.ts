// Render functions for {{> block}} placeholders: data in, SafeHtml out. They
// run in Bun for the showcase build and in the browser for the analyzer, so
// no DOM and no fs. Every value goes through html``, so text from a manifest
// or an mlog is escaped.

import type { LegSummaryRow, TrustRow } from "mlog-sql";
import { html, type SafeHtml } from "./html";
import { EMPTY_FIELD } from "./fields";
import { fmtCount, fmtMs } from "./format";
import type { Host } from "./manifest";

/** A connection id as a person should read it. */
export type Labeler = (cid: string) => string;

const num = (s: string) => html`<td class="num">${s}</td>`;

export function hostsTable(hosts: readonly Host[]): SafeHtml {
    if (hosts.length === 0) return html`<p>No host details in this session's manifest.</p>`;
    const rows = hosts.map((h) => html`<tr>
<th scope="row">${h.label}</th><td>${h.role}</td><td>${h.region ?? ""}</td><td>${h.airport ?? ""}</td>
</tr>`);
    return html`<table class="hosts">
<thead><tr><th scope="col">Host</th><th scope="col">Role</th><th scope="col">Region</th><th scope="col">Airport</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

interface SubscriberLegs {
    readonly cid: string;
    readonly legs: ReadonlyMap<number, LegSummaryRow>;
    /** Sum of the three leg means, which is the end-to-end mean. null if a leg is missing. */
    readonly e2eMean: number | null;
}

/** One entry per subscriber, fastest end-to-end first. */
export function subscriberLegs(rows: readonly LegSummaryRow[]): SubscriberLegs[] {
    const bySub = new Map<string, Map<number, LegSummaryRow>>();
    for (const r of rows) {
        const legs = bySub.get(r.sub_cid) ?? new Map<number, LegSummaryRow>();
        legs.set(r.leg_no, r);
        bySub.set(r.sub_cid, legs);
    }
    const out = [...bySub].map(([cid, legs]): SubscriberLegs => {
        const means: number[] = [];
        for (const n of [1, 2, 3]) {
            const m = legs.get(n)?.mean_ms;
            if (m !== undefined) means.push(m);
        }
        return {
            cid,
            legs,
            e2eMean: means.length === 3 ? means.reduce((a, m) => a + m, 0) : null,
        };
    });
    const key = (s: SubscriberLegs) => s.e2eMean ?? Number.POSITIVE_INFINITY;
    return out.sort((a, b) => key(a) - key(b) || (a.cid < b.cid ? -1 : 1));
}

export function legTable(rows: readonly LegSummaryRow[], label: Labeler): SafeHtml {
    const subs = subscriberLegs(rows);
    if (subs.length === 0) return html`<p>No object crossed publisher, relay and subscriber.</p>`;
    const median = (s: SubscriberLegs, n: number) => {
        const r = s.legs.get(n);
        return r === undefined ? EMPTY_FIELD : fmtMs(r.median_ms);
    };
    const body = subs.map((s) => html`<tr>
<th scope="row">${label(s.cid)}</th>${num(median(s, 1))}${num(median(s, 2))}${num(median(s, 3))}${num(s.e2eMean === null ? EMPTY_FIELD : fmtMs(s.e2eMean))}${num(fmtCount(s.legs.get(3)?.n ?? 0))}
</tr>`);
    return html`<table class="legs">
<thead><tr><th scope="col">Subscriber</th><th scope="col">Publisher → relay, median ms</th><th scope="col">Relay dwell, median ms</th><th scope="col">Relay → subscriber, median ms</th><th scope="col">End to end, mean ms</th><th scope="col">Objects</th></tr></thead>
<tbody>${body}</tbody>
</table>`;
}

export function trustTable(rows: readonly TrustRow[], label: Labeler): SafeHtml {
    if (rows.length === 0) return html`<p>No connections.</p>`;
    const body = rows.map((r) => html`<tr>
<th scope="row">${label(r.cid)}</th><td>${r.sender_is ?? EMPTY_FIELD}</td>${num(fmtCount(r.sent))}${num(fmtCount(r.received))}${num(fmtCount(r.joined))}${num(fmtCount(r.lost))}${num(fmtCount(r.outside_window))}${num(fmtCount(r.negative_hops))}
</tr>`);
    return html`<table class="trust">
<thead><tr><th scope="col">Connection</th><th scope="col">Sent from</th><th scope="col">Sent</th><th scope="col">Received</th><th scope="col">Matched</th><th scope="col">Lost</th><th scope="col">Outside log window</th><th scope="col">Negative hops</th></tr></thead>
<tbody>${body}</tbody>
</table>`;
}
