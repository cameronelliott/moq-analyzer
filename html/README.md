# chartdown

Markdown documents with live ECharts fences, on a Web Awesome page. Write a
`.md` file, get a static HTML page whose prose is readable without JavaScript
and whose charts are interactive with it.

````markdown
## Throughput

```echarts
{ xAxis: { type: 'category', data: ['Jan', 'Feb'] },
  yAxis: { type: 'value' },
  series: [{ type: 'line', data: [150, 230] }] }
```
````

## What it is not

**Not framework-neutral.** Web Awesome is woven through it: the error UI is
`<wa-callout>`, the scheme watcher reads the `wa-dark` class, the sidebar sets
`data-drawer` for `wa-page`. "Reusable elsewhere" means "on another Web Awesome
site." Making that pluggable would need a theme adapter, a pluggable error
renderer and a scheme strategy — three seams for a consumer that does not exist.

**Not a static site generator.** It exports build *functions*. Where files live,
what the shell says, and what output is called are the site's business, in
`site/build.js`. A library that also chose the file layout would be a library
you argue with.

## Layout

The split is one question: can this run without a DOM, and is it the same for
any site?

| | |
| --- | --- |
| `lib/chart-option.js` | fence dialects, page defaults, shared names. Imports nothing |
| `lib/markdown.js` | markdown → HTML. The only importer of `marked` |
| `lib/build.js` | `buildDoc`, `navHtml` — what a build needs and a browser does not |
| `lib/chart-element.js` | `<app-echart>`, `configureCharts` |
| `lib/markdown-element.js` | `<app-markdown>`, `bindNav` — for pages that render as they run |
| `lib/scheme.js` | light/dark watching and toggling |
| `lib/echarts-dark.js` | a dark theme for charts on a dark surface |
| `lib/components.css` | what the elements need from the page. One rule |
| `site/app.js` | bundle entry: components, icons, wiring |
| `site/app.css` | Web Awesome's sheet plus this site's chrome |
| `site/charts.js` | the ECharts build this site draws with |
| `site/registered-series.js` | the series allowlist, as data |
| `site/shell.js` | the HTML around a rendered document |
| `site/build.js` | globs `site/md/`, writes `dist/` |
| `site/md/*.md` | the documents |

Every file boundary in `lib/` is also a bundle boundary. That is why
`chart-option.js` and `markdown.js` are separate: a pre-rendered page imports the
chart element, and if the option helpers arrived through a module that imports
`marked`, every such page would ship a markdown parser it never calls.

## Use

```sh
bun install
bun run build     # clean, bundle JS and CSS, render pages into dist/
bun test
```

Adding a page is adding a file to `site/md/`. Its title is its first `#`
heading — no front matter. Its sidebar is its `##` headings, collected while it
rendered, so a section cannot exist without a link or be renamed out from under
one.

Serve `dist/` with anything static. Nothing is fetched from a CDN at runtime.

## Two rendering paths, one renderer

Build time (`buildDoc`) and runtime (`<app-markdown>`) both go through
`createMarkdownRenderer`. A showcase page and a live analyzer rendering the same
document must produce the same HTML; a test asserts it, and it fails the moment
`buildDoc` starts post-processing.

Static pages import only the chart element, so `marked` stays out of their
bundle. A page that renders markdown while it runs imports
`lib/markdown-element.js` and pays for it deliberately.

## Chart types

A tree-shaken ECharts only knows what it was built with, and draws nothing —
silently — for anything else. Two lists therefore have to agree:

- the `echarts/charts` imports passed to `use()` in `site/charts.js`
- `REGISTERED_SERIES` in `site/registered-series.js`

`site/charts.test.js` compares them by reading the source, because ECharts
exposes no way to ask which series types are installed. The build checks every
fence against the list and fails; the element checks at runtime and shows a
callout naming the type.

The build **checks** the list rather than generating it: a live analyzer draws
types no static document contains, so the list is the union of both and cannot
be inferred from the corpus.

## Things that will bite

**`grid.containLabel` is legacy in ECharts 6.** It does nothing unless
`LegacyGridContainLabel` is registered. `PROSE_GRID` sets it on every chart, so
dropping that feature misaligns every chart with no error.

**The stock ECharts dark theme cannot be imported.** It ships as UMD requiring
`echarts/lib/echarts` — the whole library — which undoes tree-shaking.
`lib/echarts-dark.js` is a small replacement covering text, axes, grid lines and
the dataZoom slider. Charts are transparent and sit on the page's surface, so a
theme background or palette would fight `withDefaults`; tests pin both absences.

**`parseChartOption` is an eval.** Strict JSON first, then `Function()`. Fine for
documents you author. For an option built from data you did not write — a capture
file someone uploaded — set `<app-echart>`'s `option` property instead. Nothing
is parsed and nothing is evaluated on that path.

**`bun build` warns on `::details-content`.** Its CSS parser is older than the
selector. The rule passes through unchanged; the warning is cosmetic. `site/build.js`
checks one marker per source stylesheet in the bundle so that a parser
*actually* dropping something fails the build.

**`option` replaces, it does not merge.** ECharts' `setOption` merges by
default, so a smaller option would leave the previous series behind. Setting the
property rebuilds the chart.

## Measured

Against the same page loading everything from CDNs by importmap:

| | requests | origins |
| --- | ---: | ---: |
| CDN + importmap | 682 | 5 |
| bundled | 5 | 1 |

595 of those requests were ECharts alone: esm.sh serves its internal module
graph one file at a time, and no CDN can tree-shake — `echarts/core` plus
`use([...])` saved four requests out of 595, because that API is an instruction
to a bundler.

| | raw | brotli |
| --- | ---: | ---: |
| `app.js` | 181K | 38K |
| `app.css` | 155K | 11K |
| `charts-*.js` (lazy) | 631K | 179K |

The chart chunk loads on first chart, not on page load.

## Requires

bun, and `lit`, `marked`, `echarts`, `@awesome.me/webawesome` pinned exactly.
Everything is vendored and bundled; pages carry no importmap and load nothing
from a CDN.

## History

`experiment-4-…html` is the whole thing as one 510-line file on CDNs — no build,
still runs, and the control every measurement above is against.
`experiment-5` and `experiment-6` are frozen and do not run; their headers say
what each recorded.
