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
- A detail page is `pages/<name>.md`. Its view imports it `with { type: 'text' }`, and `marked` makes the HTML (`lib/markdown.ts`).
- `markdown()` is a pure function, with no DOM and no Bun-only imports. The browser runs it now. A Bun script can use it later to write static pages.
- Do not use a Bun macro for markdown. `bun build --watch` does not rebuild when a `.md` file that a macro reads changes.
- In a page, `<div data-block="name"></div>` is a place for a table or other HTML. `fillBlocks()` fills it. A placeholder with no block, or a block with no placeholder, is an error.
- In a page, `<app-echart data-chart="name"></app-echart>` is a place for a chart. `mountCharts()` gives it its option.
- Put each placeholder on its own line, with a blank line before and after it.
- `marked` does not sanitize. Use `markdown()` only for `pages/*.md`. Text from a manifest or an mlog goes through the `html` template.

## Trace file names

- Now: a trace file name is `<cid>_<client|server>.mlog[.gz]`. `lib/trace-files.ts` gets the cid from the name and rejects other names.
- Later: expect file names with no cid, and names with no `client` or `server` part. The name rule must change then. Do not handle this now.
