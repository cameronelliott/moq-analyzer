# html3 — traps and settled decisions

Companion to `AGENTS.md`, which holds the plan. This holds only what the plan
does not say and what has already cost time in `../html` and `../html2`. Every
item was measured, not read.

## Settled — do not re-litigate

- **No SSR.** Not lit-ssr, not `@lit-labs/eleventy-plugin-lit`. Proven to work in
  `../html2`; not needed here.
- **No runtime markdown.** No `<wa-markdown>`, no markdown parser in the bundle.
  Markdown is a build-time concern only.
- **11ty's own markdown — markdown-it.** Not `marked`. This is what makes the
  above safe: one parser, at build time, and nothing to diverge from.
- **Eleventy 3.x**, under bun. Only bun is installed; `node` is bun's shim.
- **A paired shortcode, not a fence,** for charts. See below — it is markedly
  less code and avoids markdown-it's internals entirely. Not MDX, not directive
  syntax (`:::chart` is a proposal markdown-it does not ship).
- **No `<is-land>`.** See below: with a build-time SVG there is nothing to defer
  that a dynamic `import()` does not already defer in one line.
- **Ask before installing anything.**

## Heading ids

`markdown-it-anchor` (a new dependency — ask first). This is the thing
markdown-it gives for free that `marked` does not: `../html` carries a custom
`heading()` override for exactly this, and it does not need porting.

    eleventyConfig.amendLibrary('md', (md) => md.use(anchor, { slugify }));

`amendLibrary` is the documented hook for modifying the library; `setLibrary`
replaces the instance and is only needed if you construct markdown-it yourself.

## Liquid runs over the markdown — including inside fences

Standard 11ty pre-processes `.md` files as Liquid before markdown-it sees them.
So `{{` and `{%` are hazardous **anywhere in a document, fenced blocks
included**. A code sample containing template syntax needs wrapping in
`{% raw %}…{% endraw %}`.

`../html2` did not have this, because `addExtension` opts a format out of
pre-processing by another template language. Taking the standard 11ty path opts
back in. That is the hidden cost of the simple plan, and it is worth it, but it
will bite the first time a document quotes Liquid or Nunjucks.

ECharts' own `formatter: '{b}: {c}'` is single-brace and safe.

## Putting a chart on the page — three separate decisions

These are independent axes. Conflating them is the usual mistake.

| | options |
| --- | --- |
| **express** it in markdown | fenced block · paired shortcode · raw HTML |
| **render** it | build-time SVG · client canvas · both |
| **load** the JS | eagerly · deferred with `<is-land>` |

**Express: a paired shortcode.** It needs no config to work in markdown — 11ty
pre-processes `.md` as Liquid already — and it is the whole implementation:

    eleventyConfig.addPairedShortcode('echart', (config, height = '400px') =>
      renderChart(config, height));

The fence alternative costs `amendLibrary`, capturing the original rule,
delegating to it, and splitting `token.info`, plus a silent-failure mode: forget
the delegation and every *other* fence renders as `undefined` while the charts
still look fine. If a fence is ever chosen anyway, keep a plain ```js block in a
test document as the canary.

What the fence would have bought is portability — the `.md` stays valid markdown
anywhere, renders as a code block on GitHub, and degrades to a visible config if
the plugin is dropped, where a shortcode degrades to literal `{% echart %}` text.
These documents are a showcase meant to be read on the site, so that is a weak
claim against real simplicity. The starter pages use fences today; converting
them is a find-and-replace.

**Do not require strict JSON.** `../html`'s fence accepts JS object literals —
unquoted keys, trailing commas, comments — and `markdown-charts.md` has one that
builds 1000 points with `Array.from(...)`. `JSON.parse` cannot express that, so
the shortcode must parse the same way: strict JSON first, then `Function()`.

**Render: emit the SVG at build time.** ECharts has an SSR mode, and it works on
6.1.0 under bun — verified, not read:

    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    chart.dispose();

| | raw | gzip |
| --- | --- | --- |
| 4-point bar | 3,969 | 838 |
| 1000-point line | 14,302 | 3,655 |
| the ECharts runtime, for contrast | 631K | 179K brotli |

The SVG carries real `<text>` nodes with the axis labels and data in them. This
**closes the one hole `../html` and `../html2` both have** — prose is readable
with JS off, but charts are blank tags. Density does not blow it up, because
`sampling: 'lttb'` downsamples before drawing.

The build may import all of `echarts` freely; tree-shaking only matters for what
ships to the browser.

**Load: not `<is-land>`, at least not yet.** It defers *initialization* of markup
that must already be present, so it was never an alternative to a fence or a
shortcode — it wraps whatever they produce. Three reasons it does not earn its
place here:

1. With the build-time SVG the chart is **already visible**. is-land would defer
   only the ECharts JS, which buys nothing visual.
2. `../html` already defers that bundle without it:
   `configureCharts(() => import('./charts.js'))` pulls the 179K chunk on the
   first chart. A dynamic `import()` is the entire mechanism, in one line.
3. It is a dependency plus wrapper markup around every chart, for a page-weight
   problem nobody has measured.

Revisit if a page ends up with many charts below the fold and one lazy chunk is
too coarse.

So the shape is: shortcode for authoring, SVG at build time as fallback content
inside the element, and `app-echart` upgrading it to an interactive canvas when
its module loads. Progressive enhancement, not an either/or.

**Caveat:** SSR is a floor, not a replacement. `markdown-charts.md`'s `dataZoom`
slider chart is interaction-only — static SVG gives a picture of its initial zoom
window and nothing more.

**Do not** generate ids with `crypto.randomUUID()` per chart: the build stops
being deterministic, every rebuild emits different HTML, and nothing diffs. Hash
the config or use the index.

**Do not** initialise charts with a `querySelectorAll` loop on `DOMContentLoaded`.
That is not a component, and it loses what `app-echart` already does: rebuilding
on a scheme change (an ECharts theme is fixed at init, so it must be re-created),
and rendering a broken chart as an error in place instead of killing the page.

## Build

- `bun build` needs **`--production`**, or bun resolves lit's `development`
  export condition: a dev-mode warning on every page and ~16K of bundle. It is a
  resolve-condition fix, not a `NODE_ENV` one. Applies as soon as `app-echart`
  is a Lit element.
- Eleventy finds its config **by cwd**. Run from `html3/`, or it falls back to
  input `.` and output `_site` and renders whatever directory it is standing in.
  This has already happened once.
- Eleventy does not bundle, and `--serve` rebuilds pages only. Hook `bun build`
  onto the `eleventy.before` event and `addWatchTarget` the JS and CSS, or the
  dev server silently serves stale scripts. That makes one command the whole
  loop.
- `Unsupported pseudo-class 'details-content'` on Web Awesome's CSS is cosmetic.
- bun does not clean its outdir; stale hashed chunks accumulate.

## Web Awesome

- **`wa-prose` styles by descendant selector**, so it reaches whatever the build
  writes into `<article class="wa-prose">` — which is all of it. Verified: an
  `h2` inside gets `margin-block-start: 80px`, vs `0px` outside.
- It does **not** reach inside a shadow root, which is correct for `app-echart`
  and is why that component styles itself.
- `<wa-icon>` resolves to a Font Awesome CDN URL at runtime, and `wa-page` uses
  one for its mobile menu button. Override the icon library or accept the extra
  origin.

## ECharts — for `app-echart`

- `grid.containLabel` is **legacy in v6**: silently does nothing unless
  `LegacyGridContainLabel` is registered.
- Stock `echarts/theme/dark.js` is UMD requiring `echarts/lib/echarts` — the
  whole library — so importing it undoes tree-shaking. `../html/lib/echarts-dark.js`
  is a 52-line replacement.
- A tree-shaken build **draws nothing and says nothing** for an unregistered
  series type. The `use()` list and the allowlist must agree; test it by reading
  the source, because ECharts exposes no runtime way to ask.
- Parsing an option with `Function()` is an **eval**. Fine for authored
  documents; for data the site did not write, set the `option` **property**
  instead. `option` replaces, it does not merge.
- ECharts' own single-file bundle is 1,121,654 raw / 367,058 brotli. Tree-shaken
  to bar+line it is 179K brotli.

## How to verify

- `curl` for the no-JS view. `--dump-dom` runs JavaScript, so it cannot test it.
- Shadow DOM is not in `--dump-dom`. Append a probe script, read `shadowRoot`,
  write findings into `document.title`, read the title out.
- Resource timing caps at **250 entries** — any count of exactly 250 is the cap.
  Call `performance.setResourceTimingBufferSize(20000)` from a classic script in
  `<head>` before anything loads.

## Numbers to beat (`../html`, measured)

| | |
| --- | --- |
| requests / origins | 5 / 1 |
| `app.js` | 181K raw, 38K brotli |
| `app.css` | 155K raw, 11K brotli |
| `charts-*.js` | 631K raw, 179K brotli, lazy on first chart |
| without JS | prose, heading ids, nav, tables all present — **charts are blank tags** |
| machinery | 905 lines |

With no markdown parser in the bundle and no SSR client, `app.js` should come in
well under 181K — that is the number the simple plan is betting on.

The row to actually beat is the last one. Build-time SVG puts charts in the HTML
for ~1–4K gzip each, which is something neither `../html` nor `../html2` does.
