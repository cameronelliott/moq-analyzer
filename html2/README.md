# html2 — Eleventy + Web Awesome SSR spike

Answers step 1 of `BRIEF.md`. See that file for what this is and why.

## Run it

    bun install
    bun run build          # clean, then eleventy -> dist/
    bun run dev            # watch + build + serve, http://localhost:8080

`bun run dev` is the whole loop in one process. Eleventy does not bundle, so
`bun build` is hooked onto its `eleventy.before` event and runs on every
rebuild; `lib/`, `site/app*.js` and `site/app.css` are registered as watch
targets so editing a component rebuilds too. Add `--port 8000` to move it.

**Run it from `html2/`.** Eleventy finds `eleventy.config.js` by cwd. Started
from anywhere else it falls back to input `.` and output `_site`, and will
happily render whatever directory it is standing in.

`bun run serve` is a plain static server over `dist/`, for measuring without a
live-reload socket in the way.

## What is on the page

| URL | prose rendered by |
| --- | --- |
| `/` | index, generated from the `docs` collection |
| `/<slug>.html` | Eleventy, at build time. Readable with JavaScript off |
| `/live/<slug>.html` | `<app-markdown>`, in the browser |
| `/src/<slug>.md` | the markdown itself, fetched by the live page |

Both page kinds run **the same renderer** over the same document — `lib/markdown.js`
is imported by the Eleventy config and by the browser bundle. That is the
invariant, and it is tested below.

`<wa-button id="ssr-probe" hidden>` is apparatus, not UI. There has to be one
shadow-DOM component on the page or there is nothing for lit-ssr to render;
`<app-markdown>` cannot play that role because it is light DOM by design.

## Findings

**SSR works.** Under Eleventy 3.1.6 on bun, with `@lit-labs/eleventy-plugin-lit`
1.0.6 in `mode: 'worker'`:

- `curl` shows `did-ssr` on the component and a real
  `<template shadowroot="open" shadowrootmode="open">` carrying 14,632 bytes of
  shadow root with styles inlined. Not an empty custom element.
- **Zero** console output in the browser — no hydration mismatch warnings, no
  errors. The component adopts the server-rendered shadow root.
- No DSD quirks, nothing that needed silencing. None of `BRIEF.md`'s predicted
  sharp edges appeared.

**The one-renderer invariant holds.** Static and live prose are byte-identical
on both documents, after normalising two HTML entities that Chromium's DOM
serializer decodes in text position (`&#39;`, `&quot;`) and which are therefore
an artifact of how the comparison is taken, not a disagreement.

**The no-JS story is unchanged.** Static pages carry prose, heading ids and
tables with JavaScript off. Live pages carry none — which is the expected and
correct split, and the reason SSR is not the SEO story.

## Numbers

Static page: **4 requests, 1 origin.** Live page: **5** (it also fetches the
markdown). Both counts include `favicon.ico`.

| file | raw | brotli |
| --- | --- | --- |
| `app.js` (static entry) | 105 B | 91 B |
| `app-live.js` (live entry) | 47,311 | 13,233 |
| shared chunk | 140,902 | 30,497 |
| `app.css` | 158,700 | 11,045 |

The 47K delta between the two entries is `marked` plus the markdown element —
the price of rendering in the browser, which is exactly what a static page
avoids paying.

Not directly comparable to `../html`'s 181K/38K: this spike has no charts, no
scheme toggle and no icon library, so it is a smaller page, not a cheaper build
of the same page.

## Decisions taken here, against BRIEF.md

- **`marked` 18.0.14, not the pinned 15.0.12.** The chartdown renderer runs on
  18 unmodified — both overrides still work, `return false` still falls through
  to the default renderer, `this.parser.parseInline` still exists — and output is
  byte-identical to 15 on both real documents. Verified by running the renderer
  on both versions and diffing, not by reading release notes.
- **Web Awesome 3.13.0, not 3.11.0.**
- **`--production` on `bun build`.** Without it Bun resolves lit's `development`
  export condition, which ships dev-mode lit: a console warning on every page and
  16K of extra bundle. This is a resolve-condition fix, not a `NODE_ENV` one.
- **`chart-option.js` not copied.** `markdown.js` took only two string constants
  from it; they are inlined. The other 65 lines are chart-only.
- **`build.js` not copied.** Its chart half is dead here and `titleOf` is one
  line. `navHtml` is not copied either — the sidebar is a separate question and
  the prose diff already tests what it protected.
- **No `wa-page`, no scheme toggle, no icon library.** Chrome, not measurement.
  Dropping `wa-page` is what removed the need for `registerIconLibrary`.

## Not answered

Flash duration against `../html` — `BRIEF.md` pass/fail 3. Needs a paint-timing
comparison, not a DOM dump.
