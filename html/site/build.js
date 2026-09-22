// Renders site/md/*.md into dist/*.html.
//
// chartdown supplies buildDoc and navHtml; everything opinionated is here --
// where the markdown lives, what the output is called, and what counts as a
// reason to fail. That split is deliberate: a library that also chose the file
// layout would be a library you argue with.
//
// Every document is checked before any page is written, so a build that fails
// leaves no half-rendered output behind.
//
// Run as part of `bun run build`, after the JS and CSS bundles.

import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { buildDoc, navHtml } from '../lib/build.js';
import { REGISTERED_SERIES } from './registered-series.js';
import { shell } from './shell.js';

const MD_DIR = new URL('md/', import.meta.url).pathname;
const OUT_DIR = new URL('../dist/', import.meta.url).pathname;

// --- the CSS bundle is intact -------------------------------------- //
// `bun build` warns on Web Awesome's stylesheet:
//
//   Invalid selector. Unsupported pseudo-class or pseudo-element
//   'details-content'
//
// Its CSS parser does not know ::details-content, which is newer than it is.
// It passes the rule through unchanged -- checked, `details::details-content`
// is in the output -- so the warning is cosmetic and there is nothing to fix in
// the stylesheet. Silencing it would mean hiding every CSS warning, and the
// next one might matter.
//
// What is worth guarding is the class of failure the warning hints at: a
// parser that does not keep up with CSS quietly dropping something. One marker
// per source file, so a whole file going missing fails the build rather than
// showing up as a page that looks subtly wrong.
const CSS_MARKERS = [
  'details::details-content',   // native.css, and the selector bun warns about
  '.wa-prose',                  // utilities.css
  '--wa-color-',                // themes/default.css
  '@layer',                     // layers.css
  'app-markdown{display:block}', // lib/components.css
  '.scheme-icon',               // this site's own rules
];

// --- read and check ------------------------------------------------ //

const pages = [];
const problems = [];

const cssFile = Bun.file(join(OUT_DIR, 'app.css'));
if (!(await cssFile.exists())) {
  problems.push('dist/app.css is missing -- run build:css first');
} else {
  const css = await cssFile.text();
  for (const marker of CSS_MARKERS.filter((m) => !css.includes(m))) {
    problems.push(`dist/app.css lost '${marker}' -- the CSS bundler dropped something`);
  }
}

for (const file of (await readdir(MD_DIR)).filter((f) => f.endsWith('.md')).sort()) {
  const doc = buildDoc(await Bun.file(join(MD_DIR, file)).text());

  // A fence that will not parse is a broken chart on a published page, so it
  // stops the build instead. Every bad one is reported, not just the first.
  for (const { error, source } of doc.errors) {
    problems.push(`${file}: ${error}\n    ${source.split('\n')[0]}`);
  }

  // The build checks the chart allowlist rather than generating it: the live
  // analyzer draws types no static document contains, so the list has to be the
  // union of both and cannot be inferred from this corpus alone.
  for (const type of doc.seriesTypes.filter((t) => !REGISTERED_SERIES.has(t))) {
    problems.push(
      `${file}: series type '${type}' is not in site/charts.js`
      + ` (built with: ${[...REGISTERED_SERIES].join(', ')})`);
  }

  if (!doc.title) problems.push(`${file}: no h1, so the page would have no title`);

  pages.push({ slug: basename(file, '.md'), doc });
}

if (problems.length) {
  console.error(`${problems.length} problem(s), nothing written:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

// --- write --------------------------------------------------------- //

for (const { slug, doc } of pages) {
  await Bun.write(
    join(OUT_DIR, `${slug}.html`),
    shell({ title: doc.title, nav: navHtml(doc.headings), body: doc.html }));
  console.log(`  ${slug}.html  ${doc.headings.length} headings, ${doc.charts.length} charts`);
}

console.log(`${pages.length} page(s) written to dist/`);
