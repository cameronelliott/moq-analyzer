
# agents.md

**The plan is to understand how to simply do SSR, and support the browser analyzer app**



## Cameron ONLY section, not to be edited by agent


## URLs

- showcase url example1: moqanalyzer.com/real-capture/cloudflare-1
- showcase url ex2: moqanalyzer.com/real-capture/moq-newco/
- showcase url ex3: moqanalyzer.com/real-capture/
- analzyer url: moqanalyzer.com/view (with a form post with files???)



## background on analyzer

- i'm currently building a moq (media over quic session) analyzer
- it reads rfc7464 json nl mlog files, and someday qlog files
- the main analyzer tool will be browser-only without a server backend
- the analyzer tab will host duckdb-wasm
- there is a good chance /home/c/moq/a2/mlog-sql will be spun off into it's own repo, keep that in mind

## which tools and packages

- i might or might not use bun as a bundler/etc
- i have experimented with 11ty, but am questioning whether it is required
- while the main tool is browser/tab based, i want to publish a showcase of actually moq sessions, which means i need fully rendered html on disk for SEO purposes
- i have tried 11ty and lit/ssr, and it is complex
- the webawesome leader has preferred alternatives to the 11ty / lit ssr plugin because of it's complexity, see below.
- we avoid 11ty if possible

## approach

- I plan to use markdown heavily in my pages.
- we build the browser-analyzer and the static generator at the same time
- we use wa-prose if it works okay for the static markdown to html, or just css styles if the agent prefers
- we will be using webawesome, but the first version could avoid webawesome to keep the mvp simpler
- showcase pages need to be pre-rendered so web crawlers like google can crawl them and find SEO terms.

## mlog and no parquet or duckdb for now

- also, it's important to note, that while the showcase page could take a duckdb file or a parquet file, taking the original raw mlog files prevents the need to version schemas, or duckdb files or parquest files. which i think could be a big win, at the cost of loading and parsing the mlog files. yes, at this time, we prefer mlog files as input, for speed reasons later, we might allow duckdb files or parquet files. if a single url is to specify the mlog file source to the analyzer page, since most situations have multiple mlog files, the url must be to a zip of mlog files, or to a manifest of mlog files (undecided?).

## streaming

- eventually mlog data will come over a streaming interface, for dynamically updating the analyzer graphs on the analyzer pages. so that should be taken into consideration now. 




*My main question now, is there a really good alternative to using 11ty and the lit ssr plugin where I can still get fully rendered web pages on disk for my http server for SEO purposes.*




### What Claviska said on github about lit ssr vs FOUCE

original url: https://github.com/shoelace-style/webawesome/discussions/1142#discussioncomment-13714990

```quote
Support for SSR is currently experimental. There's an unlisted page with instructions here: https://webawesome.com/docs/experimental/ssr

We were using it for awhile on the backers website through the 11ty / Lit SSR plugin, but we recently switched over to the new FOUCE solution as it's much simpler and performs really well.

That said, we haven't tested it thoroughly since a few versions back so your mileage may vary. We'll try to circle back to SSR when we have more bandwidth.
```



## coding agent only section. no changes outside this H2. use concise ASD-STE100 unmannered when possible. markdown bullet points only

- Showcase pages are static HTML files on disk. A crawler must read all content without JavaScript.
- Do not use Lit SSR. Do not use the 11ty Lit SSR plugin.
- When a page uses Web Awesome, use FOUCE (`wa-cloak`) to hide components until they upgrade. The MVP can use no Web Awesome.
- Put content text in the light DOM (slots, child elements). Do not put content text in attributes.
- Convert markdown to HTML at build time by default.
- Markdown rendering is one pure function: `(markdown, data) => string`. It has no Bun-only imports (no `fs`), so the browser can use it later.
- In markdown, write a value as `{{field}}`. The build changes it to `<span data-field="field">`.
- Showcase build: write the value into the span.
- Analyzer page: the span holds `—`. The browser sets `textContent` after duckdb-wasm runs.
- If the browser must change markdown structure, bundle the same markdown function into the analyzer. Replace the section's `innerHTML` with its output.
- Use `{{field}}` in plain text only. The build fails if `{{field}}` is in a code span, a code block, a link URL, or raw HTML.
- Write a block as `{{> name}}` alone on its own line.
- Write `\{\{` for literal braces.
- `renderMarkdown` is only for our own markdown files. Text from a manifest or an mlog is plain text. Escape it with the `html` tagged template. Do not render it as markdown.
- For structure that changes with the data (table rows, lists, optional sections), use a render function `(data) => string`. Put its output in `<div data-block="name">`.
- Render functions run in Bun at build time and in the browser. Both use the same SQL.
- Keep field names and block names in one TypeScript type. The build and the browser use this type.
- `model.ts` is the one place that chooses and formats numbers. `format.ts` uses a fixed locale (`en-US`), so the build and the browser print the same text.
- Draw charts as SVG at build time. The browser upgrades them.
- Raw HTML in markdown (`<wa-*>` tags) needs a blank line before and after its markdown content, or marked does not parse that content.
- Do not use 11ty. One plain Bun build makes the showcase pages and the analyzer.
- Build: `bun run build` (runs `build/build.ts --data ../../a1/data`). Output goes to `dist/`.
- A showcase session is `showcase/<id>/manifest.json`. Its trace URLs are plain file names. The build reads the files from `<data>/<id>/` and copies them to `dist/showcase/<id>/`.
- The build deletes its output dir only if the dir holds `.html4-dist`, which the build writes.
- The analyzer is one HTML page. Dropped files and the duckdb-wasm database live in tab memory. A page load loses them.
- Do not use a SPA framework or a router library. Use hash routes (`#overview`, `#tracks`) to change views.
- Showcase pages are many pages. Each session has one URL. The build pre-renders each page. The page does not need JavaScript to show its content.
- Raw mlog files are the only input. The build and the analyzer read the same mlog files with the same parse code.
- Do not store duckdb or parquet files as a source. They need schema versions. Mlog files do not.
- Later, duckdb or parquet files can be a cache for speed. Always make the cache again from the mlog files.
- A showcase page links to `analyzer/?src=<url>`. The analyzer fetches the mlog files and opens them.
- Most sessions have many mlog files. `src` points to one file that lists or holds all of them.
- `src` points to a JSON manifest. Do not use a zip for `src`.
- The manifest holds session metadata (title, description as plain text), the mlog file list, and a label and role for each host.
- Manifest roles are labels for people. The SQL gets the real role from the data. A manifest role never goes into a query.
- `parseManifest` refuses unknown keys, cids outside `[A-Za-z0-9_-]`, URL schemes other than http(s), two URLs with one file name, and two hosts with one cid.
- The manifest holds mappings for viewers. Example: connection id (cid) to airport code or lat/long.
- File URLs in the manifest are relative to the manifest URL.
- The manifest is JSON, not TOML. The browser parses JSON natively. TOML needs a parser dependency in the browser.
- Validate the manifest by hand at the parse boundary. Do not cast `JSON.parse` output.
- Later, the analyzer can accept a dropped zip of mlog files. This does not change `src`.
- Mlog data is not trusted. The showcase shows sessions from other people.
- Render functions build HTML with an `html` tagged template. It escapes all values by default.
- Mark HTML that is already safe with a separate type (for example `SafeHtml`). Only the `html` template and the markdown function make this type.
- Set single values with `textContent`, not `innerHTML`.
- `marked` does not sanitize. If users write markdown, add a sanitizer. Ask Cameron before you add the dependency.
- Import mlog-sql by package name only: `from "mlog-sql"`. Its `exports` gives `api.ts` only. Do not import mlog-sql by a relative path; `build/imports.test.ts` fails on it. Do not read mlog-sql tables.
- mlog-sql owns `api.ts`. It hides the load steps (buffers, session variables, one connection, transaction, ICU).
- `api.ts` gives `openCapture(engine, traces)`. It returns a `Capture` with one typed function for each query. MVP: `legSummary`, `trust`.
- Mlog input is a stream: `ReadableStream<Uint8Array>` for each trace. Do not pass whole file contents as one buffer.
- Stream sources: `fetch(url).body` (browser), `Bun.file(path).stream()` (build), `File.stream()` (dropped file). Later: a WebSocket.
- The caller removes gzip with `DecompressionStream('gzip')`. `api.ts` gets plain mlog bytes.
- `api.ts` cuts the stream at record ends (LF), puts records into chunks, and loads each chunk under one `trace_name`. A record is never split between chunks.
- Live mlog over WebSocket is not in the MVP. It uses the same stream input.
- Each `Capture` function runs `SELECT` on one view. SQL views stay the source of truth. Do not write joins in TypeScript.
- duckdb-wasm returns Arrow tables. Only the engine adapter touches them. It gives plain rows (`toArray().map(r => r.toJSON())`) as `unknown`.
- `api.ts` validates each row. Do not cast rows. BIGINT comes back as `bigint`. Convert it on purpose.
- A contract test in mlog-sql (`api.test.ts`) compares each query's `DESCRIBE` output with its column spec in `QUERIES`.
- The analyzer takes mlog files without a manifest too: a file input (`multiple`, and `webkitdirectory` for a directory) and drag and drop.
- `manifestFromFiles(files)` makes a manifest from file names: `<cid>_<client|server>.mlog[.gz]`. It has no viewer mappings.
- A new chart needs a new view and a new `Capture` function in mlog-sql first.
- File names and cids come from untrusted manifests. Escape them before they go into SQL text (`SET VARIABLE`).
- Do not give html4 a free SQL function. Add it only for a later SQL console, and mark it untyped.