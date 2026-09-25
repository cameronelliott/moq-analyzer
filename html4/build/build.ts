// The static build. Every showcase session becomes a pre-rendered page whose
// numbers are in the HTML, readable with JavaScript off; the mlogs are copied
// next to it so the analyzer can open the same session from `?src=`.
//
//   bun run build/build.ts --data ../../a1/data [--out dist]
//
// A session lives in showcase/<id>/manifest.json. Its trace URLs must be plain
// file names; the files themselves are read from <data>/<id>/, so captures stay
// wherever they were recorded and only the manifest is kept here.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openCapture, type TraceSource } from "mlog-sql";
import { html, type SafeHtml } from "../src/html";
import { isGzip, parseManifest, traceName, type Manifest } from "../src/manifest";
import { renderMarkdown } from "../src/markdown";
import { loadModel } from "../src/model";
import type { PageModel } from "../src/fields";
import { page } from "../src/shell";
import { nodeEngine } from "./engine-node";

const ROOT = join(import.meta.dir, "..");
/** Written into every output dir, so a rebuild only ever deletes its own output. */
const MARKER = ".html4-dist";
const PLAIN_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BuildOptions {
    /** Where showcase/<id>/'s mlog files are: <data>/<id>/<file>. */
    readonly data: string;
    readonly out: string;
    readonly log?: (line: string) => void;
}

export interface BuiltSession {
    readonly id: string;
    readonly title: string;
    readonly traces: number;
    readonly loadMs: number;
}

export class BuildError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BuildError";
    }
}

function prepareOut(out: string): void {
    if (existsSync(out)) {
        if (!existsSync(join(out, MARKER))) {
            throw new BuildError(`refusing to delete ${out}: it has no ${MARKER}, so this build did not make it`);
        }
        rmSync(out, { recursive: true });
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, MARKER), "");
}

function readManifest(dir: string, id: string): Manifest {
    const path = join(dir, "manifest.json");
    // JSON.parse returns any; typing it unknown is the point -- parseManifest checks it.
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const m = parseManifest(raw);
    if (m.id !== id) throw new BuildError(`${path}: id "${m.id}" does not match its directory "${id}"`);
    for (const t of m.traces) {
        if (!PLAIN_FILE_RE.test(t.url)) {
            throw new BuildError(`${path}: showcase trace URLs must be plain file names, got "${t.url}"`);
        }
    }
    return m;
}

async function buildSession(m: Manifest, o: BuildOptions, template: string): Promise<BuiltSession> {
    const srcDir = join(o.data, m.id);
    const outDir = join(o.out, "showcase", m.id);
    mkdirSync(outDir, { recursive: true });

    for (const t of m.traces) {
        const src = join(srcDir, t.url);
        if (!existsSync(src)) throw new BuildError(`${m.id}: missing mlog ${src}`);
        await Bun.write(join(outDir, t.url), Bun.file(src));
    }

    const sources: TraceSource[] = m.traces.map((t) => {
        const bytes = Bun.file(join(srcDir, t.url)).stream();
        return {
            name: traceName(t),
            cid: t.cid,
            stream: isGzip(t) ? bytes.pipeThrough(new DecompressionStream("gzip")) : bytes,
        };
    });

    const t0 = performance.now();
    const db = await nodeEngine();
    let model: PageModel;
    try {
        model = await loadModel(m, await openCapture(db.engine, sources));
    } finally {
        db.close();
    }
    const loadMs = performance.now() - t0;

    const analyzerHref = `/analyzer/?src=${encodeURIComponent(`/showcase/${m.id}/manifest.json`)}`;
    const body = html`${renderMarkdown(template, model)}
<p><a href="${analyzerHref}">Open this session in the analyzer</a></p>`;

    writeFileSync(join(outDir, "index.html"), page({ title: m.title, description: m.description, body }).value);
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");

    return { id: m.id, title: m.title, traces: m.traces.length, loadMs };
}

function showcaseIndex(sessions: readonly Manifest[]): SafeHtml {
    const items = sessions.map((m) => html`<li><a href="/showcase/${m.id}/">${m.title}</a><br>${m.description}</li>`);
    return page({
        title: "Showcase: analyzed MoQ sessions",
        description: "Real Media over QUIC sessions, analyzed from their mlog files.",
        body: html`<h1>Showcase</h1>
<p>Real Media over QUIC sessions, each analyzed from the mlog files logged at both ends of every connection.</p>
<ul class="sessions">${items}</ul>`,
    });
}

export async function build(o: BuildOptions): Promise<BuiltSession[]> {
    const log = o.log ?? (() => undefined);
    prepareOut(o.out);
    writeFileSync(join(o.out, "style.css"), readFileSync(join(ROOT, "site", "style.css")));

    const home = renderMarkdown(readFileSync(join(ROOT, "content", "index.md"), "utf8"), null);
    writeFileSync(join(o.out, "index.html"), page({
        title: "MoQ session analyzer",
        description: "Analyze Media over QUIC sessions from mlog files, in your browser or from the showcase.",
        body: home,
    }).value);

    const template = readFileSync(join(ROOT, "content", "session.md"), "utf8");
    const showcase = join(ROOT, "showcase");
    const ids = readdirSync(showcase, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(showcase, d.name, "manifest.json")))
        .map((d) => d.name)
        .sort();

    const manifests = ids.map((id) => readManifest(join(showcase, id), id));
    const built: BuiltSession[] = [];
    for (const m of manifests) {
        const s = await buildSession(m, o, template);
        log(`showcase/${s.id}: ${s.traces} traces loaded in ${(s.loadMs / 1000).toFixed(1)} s`);
        built.push(s);
    }

    mkdirSync(join(o.out, "showcase"), { recursive: true });
    writeFileSync(join(o.out, "showcase", "index.html"), showcaseIndex(manifests).value);
    return built;
}

if (import.meta.main) {
    const { values } = parseArgs({
        options: { data: { type: "string" }, out: { type: "string" } },
        strict: true,
    });
    if (values.data === undefined) {
        console.error("usage: bun run build/build.ts --data <dir holding <id>/*.mlog.gz> [--out dist]");
        process.exit(2);
    }
    const t0 = performance.now();
    const built = await build({
        data: resolve(values.data),
        out: resolve(values.out ?? join(ROOT, "dist")),
        log: (line) => console.log(line),
    });
    console.log(`built ${built.length} showcase page(s) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
