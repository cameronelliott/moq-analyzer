// RFC 4180 fields. NULL is an empty field; an empty string is `""`, so the two
// stay apart on the way back in.

export type CsvValue = string | number | null;

export function csvField(v: CsvValue): string {
    if (v === null) return "";
    if (typeof v === "number") return String(v);
    if (v === "" || /[",\r\n]/.test(v)) return `"${v.replaceAll('"', '""')}"`;
    return v;
}

/** A header line, then one line per row, each ending in LF. */
export function* csvLines<R extends Readonly<Record<K, CsvValue>>, K extends string>(
    columns: readonly K[],
    rows: Iterable<R>,
): Generator<string> {
    yield columns.join(",") + "\n";
    for (const r of rows) yield columns.map((c) => csvField(r[c])).join(",") + "\n";
}
