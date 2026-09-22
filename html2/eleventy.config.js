// Eleventy replaces ../html/site/build.js: the glob, the render loop and the
// write. What it does NOT replace is the renderer -- chartdown's own markdown
// module is registered as a custom template format below, so the build and the
// browser parse with the same code. Eleventy's built-in markdown-it never runs.
//
// Two outputs per document, on purpose:
//
//   dist/<slug>.html        static. Prose and heading ids are in the HTML,
//                           readable with JavaScript off.
//   dist/live/<slug>.html   the same document rendered by <app-markdown> in the
//                           browser.
//
// Diffing the prose of the two is the test that matters.

import litPlugin from '@lit-labs/eleventy-plugin-lit';

import { createMarkdownRenderer, titleOf } from './lib/markdown.js';
import { shell } from './site/_shell.js';

const renderer = createMarkdownRenderer();

export default function (eleventyConfig) {
  // Eleventy does not bundle, so JS and CSS are bun build's job -- but a dev
  // server that rebuilds pages and not bundles serves stale scripts, which is
  // worse than not serving them. Hooking the bundle onto Eleventy's own build
  // event makes `--serve` a real watch/build/serve in one process.
  //
  // Shelling out to the package scripts rather than calling Bun.build() keeps
  // package.json the single place the bundler flags are written -- notably
  // --production, without which bun resolves lit's `development` export
  // condition and ships dev-mode lit.
  eleventyConfig.on('eleventy.before', async () => {
    await Bun.$`bun run build:js`.quiet();
    await Bun.$`bun run build:css`.quiet();
  });

  // Eleventy watches templates and data. These are neither, so it has to be
  // told, or editing a component never triggers a rebuild.
  eleventyConfig.addWatchTarget('./lib/');
  eleventyConfig.addWatchTarget('./site/app.js');
  eleventyConfig.addWatchTarget('./site/app-live.js');
  eleventyConfig.addWatchTarget('./site/app.css');

  // Server-renders the wa-* elements the shell emits into declarative shadow
  // DOM. <app-markdown> is deliberately absent: it is light DOM, lit-ssr
  // supports shadow DOM only, and the static page does not need it because the
  // build already injected the HTML a render would have produced.
  eleventyConfig.addPlugin(litPlugin, {
    mode: 'worker',
    componentModules: [
      'node_modules/@awesome.me/webawesome/dist/components/button/button.js',
    ],
  });

  eleventyConfig.addExtension('md', {
    outputFileExtension: 'html',
    // Flat: dist/<slug>.html, not dist/md/<slug>/index.html. Keeps the output
    // directly comparable to ../html's dist/.
    getData: () => ({ permalink: (data) => `${data.page.fileSlug}.html` }),
    compile: (inputContent) => () => {
      const { body, headings } = renderer.render(inputContent);
      return shell({ title: titleOf(headings), body, mode: 'static' });
    },
  });

  // The markdown itself, for the live pages to fetch at runtime. Served under
  // src/ rather than md/ so it cannot collide with a page's own output path.
  eleventyConfig.addPassthroughCopy({ 'site/md': 'src' });

  return {
    dir: { input: 'site', output: 'dist', includes: '_includes' },
    templateFormats: ['md', '11ty.js'],
  };
}
