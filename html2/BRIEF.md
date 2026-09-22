# html2 — Eleventy + SSR spike

Self-contained brief. Parallel to `../html`, not a replacement.

**Question:** is Eleventy 3 + Web Awesome SSR + hydration a better basis than
`../html`'s build-to-static model?

**Expectation, stated up front so the spike is not judged wrong:** this is not
expected to reduce code. Eleventy touches ~120 of `../html`'s 905 lines of
machinery; the other 595 (chart element, chart provider, option handling,
scheme, elements, CSS) are untouched. The case for it is *capability not yet
built* — a showcase index from collections, one page per capture from
pagination, a dev server with live reload, sitemap. Judge the spike on SSR
working and on the dev loop, not on line count.

**And SSR is not the SEO story.** Web Awesome's own docs say SSR components are
not meant to fully work without JavaScript. The indexable text in `../html` —
prose, headings with ids, nav, tables — is light-DOM HTML that is already
present with JS off. SSR buys the shell not flashing in. That is worth
something; it is not worth regressing what already works.

---

## What exists in ../html (the thing being compared)

A markdown-to-static-pages build called **chartdown**. Write `site/md/x.md`, get
`dist/x.html`: prose readable with JavaScript off, charts interactive with it.

    lib/chart-option.js    fence dialects, PROSE_GRID, seriesTypesOf, CHART_TAG.
                           Imports nothing
    lib/markdown.js        createMarkdownRenderer — the only importer of `marked`
    lib/build.js           buildDoc(md) -> {html,title,headings,charts,
                           seriesTypes,errors}; navHtml(headings)
    lib/chart-element.js   <app-echart>, configureCharts
    lib/markdown-element.js <app-markdown>, bindNav — runtime rendering
    lib/scheme.js          light/dark watching and toggling
    lib/echarts-dark.js    dark theme for charts on a dark surface
    lib/components.css     one rule: app-markdown { display: block }
    site/app.js            bundle entry: components, icon library, wiring
    site/app.css           WA stylesheet + site chrome
    site/charts.js         the tree-shaken ECharts build
    site/registered-series.js  the series allowlist, as data
    site/shell.js          the HTML around a rendered document
    site/build.js          globs site/md/, writes dist/
    site/md/*.md           the documents
    frozen/                dead copies, only so experiment 5 and 6 still run
    experiment-1..6.html   history; 4 is the CDN control and still runs

`bun run build` = clean, bundle JS, bundle CSS, render pages. `bun test` = 47
tests across 5 files. Read `../html/README.md` first; it documents the traps.

---

## Settled — do not re-litigate

- **Eleventy 3.x stable.** Not 4.x. Not `@awesome.me/buildawesome` — that is 16
  lines of JS over `@11ty/eleventy@4.0.0-alpha.10` and adds nothing
  Web-Awesome-specific. Three moving alpha parts at once is untestable.
- **Eleventy 3 runs under bun.** Confirmed by the user.
- **Keep chartdown's markdown renderer.** Register it with `addExtension` as a
  custom template format; do *not* use Eleventy's markdown-it. The live analyzer
  renders markdown in the browser, and two parsers means the showcase page and
  the live page can render the same document differently. There is a test
  asserting they agree (`lib/build.test.js`).
- **No MDX.** It compiles to a component tree, not HTML, so runtime markdown
  would need the MDX compiler in the browser. It also needs a JSX runtime, which
  means React/Preact beside lit — a second component model. For one component
  with a large config blob, a fence beats JSX props.
- **Charts are never server-rendered.** Canvas. `app-echart` stays client-only
  with its own lazy chunk.
- **Eleventy does not bundle.** Keep `bun build` for JS and CSS.
- **Eleventy alone gives zero SSR.** Server-rendering `<wa-page>` into
  declarative shadow DOM is separate work with lit-ssr on top. "Eleventy it is"
  did not decide the SSR question — step 1 does.
- **Eleventy is the right generator because Web Awesome documents it.** The SSR
  guide's only worked example is 11ty with `@lit-labs/eleventy-plugin-lit`.
- **DuckDB-wasm stays behind a file drop**, never on page load.
- **Ask before installing anything.** (Project rule, `~/.claude/CLAUDE.md`.)

---

## Environment

Only **bun** is installed. There is **no npm**; `node` on PATH is bun's shim.
`python3` and `chromium` are available. Shell is fish — one command per call, no
`&&` chaining.

---

## Reuse from ../html, do not reimplement

Pure, framework-neutral, callable from an Eleventy transform unchanged:
`lib/chart-option.js`, `lib/markdown.js`, `lib/build.js`.

Browser-side, unaffected by the build model: `lib/chart-element.js`,
`lib/scheme.js`, `lib/echarts-dark.js`, `lib/components.css`.

Copy `site/md/*.md` verbatim so output is comparable.

Replaced by this spike: `site/build.js` → Eleventy config; `site/shell.js` → a
layout, and a lit template if SSR lands.

---

## Web Awesome SSR — the documented path

From <https://webawesome.com/docs/ssr/>. Web Awesome documents **11ty
specifically**, which is why Eleventy is the choice.

Server side, via the Lit labs Eleventy plugin:

```js
import litPlugin from '@lit-labs/eleventy-plugin-lit';

eleventyConfig.addPlugin(litPlugin, {
  mode: 'worker',
  componentModules: [
    '@awesome.me/webawesome/dist/components/button/button.js',
  ],
});
```

Every `wa-*` component used on a page must be listed in `componentModules` —
for us at least `page`, `button`, and `callout`.

Client side, either the SSR loader:

```html
<script type="module" src="/dist/webawesome.ssr-loader.js"></script>
```

or, when bundling (our case), the hydrate support **before any component
import**:

```js
import '@lit-labs/ssr-client/lit-element-hydrate-support.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
```

Order matters. In `site/app.js` terms that line goes first, above everything.

**FOUC:** SSR'd components get a `did-ssr` attribute. Hide only the ones that
did not:

```css
:not([did-ssr]):not(:defined) { visibility: hidden; }
```

**`with-*` attributes:** slot detection does not work server-side because there
is no DOM, so components like `<wa-dialog with-footer>` need told explicitly.
Check every component used for a `with-*` requirement.

### Documented limitations — read before judging step 1

- **"SSR components are NOT meant to fully work without JavaScript."** This is
  the important one. It means **WA SSR is not an SEO feature** — it removes the
  shell flash, nothing more. Our indexable text is prose, headings, nav and
  tables in the light DOM, which are not WA components and are already present
  without JS in `../html`. Do not let SSR become a justification for the SEO
  goal; that goal is already met and must not regress.
- `<wa-icon>` has no fallback rendering without JavaScript.
- `<wa-qr-code>` and `<wa-chart>` need client-side canvas. (We use neither;
  `app-echart` is ours and is client-only by design.)
- `@shoelace-style/localize` is English-only during SSR.

### Our own components under SSR

Two limitations, from different places. Do not conflate them.

**WA's warning is about WA's components' behaviour** — `wa-icon` fetching an
SVG, animations, interactivity. It is not a statement about lit-ssr.

**Lit SSR's own limitation does hit us:** *"Only Lit components using shadow DOM
is supported"* (<https://lit.dev/docs/ssr/overview/>).

- `<app-markdown>` returns `this` from `createRenderRoot()` — light DOM on
  purpose, so `wa-prose`'s descendant selectors reach the generated headings,
  lists and tables. **It therefore cannot be server-rendered, and must not be.**
  It does not need to be: `buildDoc(md)` returns an HTML string and the layout
  injects it. No component at build time. Reaching for lit-ssr here would be
  re-solving, with a limitation, what a function call already does.
- `<app-echart>` **is** shadow DOM, so it can be server-rendered, and should be:
  its `render()` emits a correctly-sized empty box, so the page does not reflow
  when the chart arrives. Nothing else about it is server-renderable — canvas.

Lit SSR lifecycle (<https://lit.dev/docs/ssr/authoring/>):

| runs on server | does not |
| --- | --- |
| `constructor`, `hasChanged`, `willUpdate`, `render` | `connectedCallback`, `disconnectedCallback`, `attributeChangedCallback`, `shouldUpdate`, `update`, `firstUpdated`, `updated` |

So the `isServer` guards in `../html`'s elements are belt-and-braces —
`updated()` and `connectedCallback()` never run server-side anyway. Harmless;
leave them. Async directives (`asyncAppend`, `asyncReplace`) produce nothing
server-side; async work in components is unsupported generally.

### New packages this needs

`@lit-labs/eleventy-plugin-lit`, `@lit-labs/ssr-client`, `@11ty/eleventy@3`.
Ask before installing.

`@lit-labs/eleventy-plugin-lit` is at **1.0.6**, published 2025-12-23, depending
on `@lit-labs/ssr@^4` and `lit@^2.7 || ^3`. No peer deps declared, so nothing
stops a second lit being installed — keep everything resolving from one
`node_modules` so there is exactly one `lit@3.3.3`. Two copies of lit means two
`ReactiveElement` registries and hydration failures that make no sense.

---

## Step 1 — only this

**One page. `<wa-page>` and `<wa-button>`, server-rendered and hydrated. No
markdown, no charts.**

Pass/fail:

1. `curl` the output — do the components carry `did-ssr` and real declarative
   shadow DOM, or are they empty custom elements?
2. Any hydration mismatch warnings in the console?
3. Is there a visible flash, and how long? This is the whole point — measure it
   against `../html`, which has the same flash today and may or may not be
   noticeably worse.
4. Requests and bytes, against 5 requests from 1 origin.

Likeliest sharp edges: the worker-mode plugin needs WA's components importable
and renderable in node; and `@lit-labs/eleventy-plugin-lit` is labs-tier, so
check it actually supports Eleventy 3 before assuming.

**Stop and report either way before step 2.** If it is painful — DSD quirks,
mismatch warnings that cannot be silenced, components that will not render in
node — say so and stop. Eleventy-without-SSR can be adopted later, cheaply, and
teaches little; the SSR answer is the only thing here that is genuinely unknown.

---

## Numbers to beat (../html, measured)

| | |
| --- | --- |
| requests / origins | 5 / 1 |
| `app.js` | 181K raw, 38K brotli |
| `app.css` | 155K raw, 11K brotli |
| `charts-*.js` | 631K raw, 179K brotli, lazy on first chart |
| without JS | prose, headings with ids, filled nav, tables all present |
| machinery | 905 lines |
| tests | 47 |

History, for contrast: the same page on CDNs by importmap was **682 requests
across 5 origins**, 595 of them ECharts alone. Two findings behind that:

- esm.sh serves a package's internal module graph one file at a time and
  **cannot tree-shake**. `echarts/core` + `use([...])` saved 4 requests out of
  595 — that API is an instruction to a bundler, not a CDN.
- ECharts ships its own single-file bundle:
  `cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.esm.min.js`, 1 request,
  1,121,654 raw / 367,058 brotli. Tree-shaking to bar+line took it to 179K
  brotli.

---

## Pinned versions

`lit@3.3.3`, `marked@15.0.12`, `echarts@6.1.0`,
`@awesome.me/webawesome@3.11.0`. Exact, no ranges.

---

## Traps — all of these cost time already

**ECharts**

- `grid.containLabel` is **legacy in ECharts 6**: it silently does nothing unless
  `LegacyGridContainLabel` is registered. `PROSE_GRID` sets it on every chart.
- The stock `echarts/theme/dark.js` is **UMD requiring `echarts/lib/echarts`** —
  the whole library — so importing it undoes tree-shaking.
  `lib/echarts-dark.js` is a 52-line replacement.
- A tree-shaken ECharts **draws nothing and says nothing** for an unregistered
  series type. Two lists must agree: the `echarts/charts` imports passed to
  `use()` in `site/charts.js`, and `REGISTERED_SERIES` in
  `site/registered-series.js`. `site/charts.test.js` compares them by reading
  the source, because ECharts exposes no runtime way to ask.
- The build **checks** that list rather than generating it: the live analyzer
  draws types no static document contains, so it is the union of both.

**Security**

- `parseChartOption` is an **eval** — strict JSON first, then `Function()`. Fine
  for authored documents. For an option built from data the site did not write
  (an uploaded capture), set `<app-echart>`'s **`option` property** instead;
  nothing is parsed or evaluated on that path.
- `option` **replaces, does not merge** — ECharts' `setOption` merges by
  default, so a smaller option would leave old series behind.

**DuckDB-wasm** (for the analyzer, later)

- `1.32.0` is the last stable; npm's `latest` tag is `1.33.1-dev57.0`, a **dev
  build**. Never resolve it by range.
- `duckdb-eh.wasm` is 34,242,586 raw / **6,764,975 brotli**; worker 188,628.
  Non-isolated pages get the `eh` bundle, `pthreadWorker` null, no threads.
- **ICU is not in the bundle** and autoloads from `extensions.duckdb.org` the
  moment any SQL touches a timezone — a silent 1.4 MB. `install_mode` is
  `REPOSITORY`; only `core_functions` is statically linked. Keep times as
  `TIMESTAMP` or `BIGINT` micros, never `TIMESTAMPTZ`, never `SET TimeZone`.
  Verified working without ICU: `date_trunc`, `strftime`, `make_timestamp`,
  `date_diff`, interval subtraction.

**Build**

- `bun build` warns `Unsupported pseudo-class or pseudo-element
  'details-content'` on Web Awesome's CSS. **Cosmetic** — the rule passes
  through unchanged. `site/build.js` checks one marker per source stylesheet in
  the output so a parser that *does* drop something fails the build.
- Bun does not clean its output directory; stale hashed chunks accumulate. There
  is a `clean` script for that.

---

## How to verify

    python3 -m http.server <port> --bind 127.0.0.1
    chromium --headless --no-sandbox --disable-gpu --dump-dom <url>

- **Shadow DOM is not in `--dump-dom`.** Inspect `shadowRoot` from a probe
  script appended to a copy of the page.
- **`--dump-dom` needs JavaScript**, so it cannot test the no-JS case. Use
  `curl` — that is what a non-executing crawler sees anyway.
- **Resource-timing buffer caps at 250 entries.** Any count that comes back as
  exactly 250 is the cap, not a count. Call
  `performance.setResourceTimingBufferSize(20000)` from a classic `<script>` in
  `<head>`, before anything loads.
- **Worker fetches are invisible** to main-thread resource timing — DuckDB's
  34 MB wasm never appears. Size those with `curl`.
- **`--virtual-time-budget` expires** during long WASM compiles and truncates
  the run. For slow pages, POST results to a small local server and run chromium
  under `timeout`.
- The probe pattern used throughout `../html`: append a module script that waits,
  reads shadow roots, clicks the scheme toggle, waits again, and writes findings
  into `document.title`, then read the title out of `--dump-dom`.

---

## Why SSR is being reconsidered at all

`../html` renders markdown to HTML at build time and ships components only for
charts. That was chosen deliberately, and the reasoning still holds for
documents: no component computes text, so server-rendering components produces
markup you already had.

It stops holding if the analyzer grows components that own **both markup and
text** — a filterable table, linked brushing, a drill-down panel. Those cannot
be expressed as a markdown fence without inventing a worse templating language,
and that is the point at which SSR-with-hydration is the shape that fits.

Nothing is foreclosed: `isServer` guards are still in the elements, Web Awesome
ships an SSR loader, and the pipeline does not depend on components. The only
thing that must change for SSR is `site/shell.js` — 62 lines of template literal
that would become a lit template.

---

## Out of scope

Splitting chartdown into its own repo. Replacing `../html`. DuckDB integration.
Rewriting the chart element.
