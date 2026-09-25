// A session manifest: what `analyzer/?src=` points at, and what the showcase
// build reads. It lists the session's mlog files and carries what a viewer
// needs that no mlog records -- place names, regions, which host is which.
//
// Manifests can come from other people, so parseManifest checks every field,
// refuses keys it does not know (a typo fails loudly instead of vanishing), and
// keeps cids to a narrow alphabet. Text fields are plain text: render them
// with html``, never as markdown.
//
// Roles here are labels for people. The SQL derives the real role from the
// data (vantage_point), and nothing in this file feeds into a query.

export type End = "client" | "server";
export type Role = "publisher" | "relay" | "subscriber";

export interface TraceRef {
    /** Relative to the manifest's own URL, or absolute http(s). */
    readonly url: string;
    readonly cid: string;
    readonly end: End;
}

export interface Host {
    readonly label: string;
    readonly role: Role;
    /** null for a host with no connection id of its own (the relay). */
    readonly cid: string | null;
    readonly region?: string;
    /** IATA code, three capital letters. */
    readonly airport?: string;
    readonly lat?: number;
    readonly lon?: number;
}

export interface Manifest {
    readonly version: 1;
    /** URL slug for the showcase page. */
    readonly id: string;
    readonly title: string;
    /** Plain text. */
    readonly description: string;
    readonly traces: readonly TraceRef[];
    readonly hosts: readonly Host[];
}

export class ManifestError extends Error {
    readonly path: string;
    constructor(path: string, message: string) {
        super(`manifest ${path}: ${message}`);
        this.name = "ManifestError";
        this.path = path;
    }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AIRPORT_RE = /^[A-Z]{3}$/;
const MLOG_NAME_RE = /^([A-Za-z0-9_-]{1,64})_(client|server)\.mlog(\.gz)?$/;

// --- small checks, each naming the path that failed -------------------------

type Obj = { readonly [k: string]: unknown };

function obj(v: unknown, path: string, keys: readonly string[]): Obj {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw new ManifestError(path, "expected an object");
    }
    for (const k of Object.keys(v)) {
        if (!keys.includes(k)) throw new ManifestError(`${path}.${k}`, "unknown key");
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = Reflect.get(v, k);
    return out;
}

function str(v: unknown, path: string, re?: RegExp): string {
    if (typeof v !== "string") throw new ManifestError(path, "expected a string");
    if (re !== undefined && !re.test(v)) throw new ManifestError(path, `does not match ${re}`);
    return v;
}

function nonEmpty(v: unknown, path: string): string {
    const s = str(v, path);
    if (s.trim() === "") throw new ManifestError(path, "is empty");
    return s;
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
    const found = allowed.find((a) => a === v);
    if (found === undefined) throw new ManifestError(path, `expected one of ${allowed.join(", ")}`);
    return found;
}

function num(v: unknown, path: string, min: number, max: number): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
        throw new ManifestError(path, `expected a number from ${min} to ${max}`);
    }
    return v;
}

function list(v: unknown, path: string): readonly unknown[] {
    if (!Array.isArray(v)) throw new ManifestError(path, "expected an array");
    return v;
}

/** A trace URL: relative, or absolute http(s). No other scheme. */
function traceUrl(v: unknown, path: string): string {
    const s = nonEmpty(v, path);
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s)?.[1]?.toLowerCase();
    if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
        throw new ManifestError(path, `scheme ${scheme}: is not allowed`);
    }
    if (s.startsWith("//")) throw new ManifestError(path, "protocol-relative URLs are not allowed");
    if (!/\.mlog(\.gz)?$/.test(s)) throw new ManifestError(path, "expected a .mlog or .mlog.gz file");
    return s;
}

// --- the parsers ------------------------------------------------------------

function parseTrace(v: unknown, path: string): TraceRef {
    const o = obj(v, path, ["url", "cid", "end"]);
    return {
        url: traceUrl(o["url"], `${path}.url`),
        cid: str(o["cid"], `${path}.cid`, CID_RE),
        end: oneOf(o["end"], `${path}.end`, ["client", "server"] as const),
    };
}

function parseHost(v: unknown, path: string): Host {
    const o = obj(v, path, ["label", "role", "cid", "region", "airport", "lat", "lon"]);
    const cid = o["cid"] === null ? null : str(o["cid"], `${path}.cid`, CID_RE);
    return {
        label: nonEmpty(o["label"], `${path}.label`),
        role: oneOf(o["role"], `${path}.role`, ["publisher", "relay", "subscriber"] as const),
        cid,
        ...(o["region"] === undefined ? {} : { region: nonEmpty(o["region"], `${path}.region`) }),
        ...(o["airport"] === undefined ? {} : { airport: str(o["airport"], `${path}.airport`, AIRPORT_RE) }),
        ...(o["lat"] === undefined ? {} : { lat: num(o["lat"], `${path}.lat`, -90, 90) }),
        ...(o["lon"] === undefined ? {} : { lon: num(o["lon"], `${path}.lon`, -180, 180) }),
    };
}

/** Check a parsed JSON value and return it as a Manifest. Throws ManifestError. */
export function parseManifest(v: unknown): Manifest {
    const o = obj(v, "$", ["version", "id", "title", "description", "traces", "hosts"]);
    if (o["version"] !== 1) throw new ManifestError("$.version", "expected 1");

    const traces = list(o["traces"], "$.traces").map((t, i) => parseTrace(t, `$.traces[${i}]`));
    if (traces.length === 0) throw new ManifestError("$.traces", "lists no mlog files");

    // trace.filename is a trace's identity in the database, so two URLs that
    // name the same file would collide at load time. Say so here instead.
    const seen = new Map<string, number>();
    traces.forEach((t, i) => {
        const name = traceName(t);
        const first = seen.get(name);
        if (first !== undefined) {
            throw new ManifestError(`$.traces[${i}].url`, `same file name as $.traces[${first}]: ${name}`);
        }
        seen.set(name, i);
    });

    const hosts = list(o["hosts"], "$.hosts").map((h, i) => parseHost(h, `$.hosts[${i}]`));
    const cids = new Set(traces.map((t) => t.cid));
    const hostOf = new Map<string, number>();
    hosts.forEach((h, i) => {
        if (h.cid === null) return;
        if (!cids.has(h.cid)) {
            throw new ManifestError(`$.hosts[${i}].cid`, `no trace has cid ${h.cid}`);
        }
        const first = hostOf.get(h.cid);
        if (first !== undefined) {
            throw new ManifestError(`$.hosts[${i}].cid`, `same cid as $.hosts[${first}]`);
        }
        hostOf.set(h.cid, i);
    });

    return {
        version: 1,
        id: str(o["id"], "$.id", ID_RE),
        title: nonEmpty(o["title"], "$.title"),
        description: str(o["description"], "$.description"),
        traces,
        hosts,
    };
}

// --- helpers for loading ----------------------------------------------------

/** The last path segment of a trace URL, without .gz: the trace's identity. */
export function traceName(t: TraceRef): string {
    const last = t.url.split(/[?#]/)[0]?.split("/").pop() ?? t.url;
    return last.replace(/\.gz$/, "");
}

export function isGzip(t: TraceRef): boolean {
    return /\.gz$/.test(t.url.split(/[?#]/)[0] ?? "");
}

// --- files without a manifest -----------------------------------------------

export interface FromFiles {
    readonly manifest: Manifest;
    /** Names that are not `<cid>_<client|server>.mlog[.gz]`, left out. */
    readonly skipped: readonly string[];
}

/**
 * A manifest for mlog files picked or dropped in the analyzer. Each name must
 * be `<cid>_<client|server>.mlog[.gz]`; anything else (qlogs, csvs, notes) is
 * skipped and reported. A path from a directory pick (`webkitRelativePath`)
 * is fine: only the last segment counts. The URL of each trace is its file
 * name, which the caller maps back to its File. No hosts: files carry no
 * place names.
 */
export function manifestFromFiles(paths: readonly string[]): FromFiles {
    const traces: TraceRef[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();

    for (const p of paths) {
        const name = p.split("/").pop() ?? p;
        const m = MLOG_NAME_RE.exec(name);
        const cid = m?.[1];
        const end = m?.[2];
        if (cid === undefined || (end !== "client" && end !== "server")) {
            skipped.push(p);
            continue;
        }
        const t: TraceRef = { url: name, cid, end };
        if (seen.has(traceName(t))) {
            throw new ManifestError("files", `two files are named ${traceName(t)}`);
        }
        seen.add(traceName(t));
        traces.push(t);
    }
    if (traces.length === 0) {
        throw new ManifestError("files", "no <cid>_<client|server>.mlog[.gz] files among them");
    }
    traces.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

    return {
        manifest: {
            version: 1,
            id: "local",
            title: "Local mlog files",
            description: "",
            traces,
            hosts: [],
        },
        skipped,
    };
}
