# html5

- html5 is the MoQ analyzer as one page (SPA). It is based on ../html3.
- The analyzer only. Static pages for SEO come later, and not now.
- Bun builds and serves `index.html`. Do not use 11ty.
- Write TypeScript. Do not write JavaScript files.
- Web Awesome, Lit and ECharts are the UI packages.
- Charts get an ECharts option as a property. Do not parse or eval a chart config string.
- Import mlog-sql by package name only: `from "mlog-sql"`.
- Serve duckdb-wasm's worker and wasm from `dist/`. Do not use a CDN.
- `bun run dev` rebuilds `dist/` on every change. `bun run build` writes `dist/` for a deploy.
- Caddy serves `dist/` on :8082 (`/home/c/moq/Caddyfile`, user unit `caddy-html3`). Hashed files get an immutable cache header, and all other files get `no-cache`.
- Do not use `bun ./index.html`. Its dev server does not serve files imported `with { type: 'file' }`, so the duckdb worker and wasm do not load.
- duckdb starts at page load, before the reader picks files. After each load, the next engine starts.

## Prose

- Cameron rewrites all page text later. Keep text easy to find and edit.
- Put long text and text with much formatting in markdown files, not in TypeScript.
- Decide how markdown becomes HTML before the first page with long text. Ask Cameron before you add a markdown dependency.

## Trace file names

- Now: a trace file name is `<cid>_<client|server>.mlog[.gz]`. `lib/trace-files.ts` gets the cid from the name and rejects other names.
- Later: expect file names with no cid, and names with no `client` or `server` part. The name rule must change then. Do not handle this now.
