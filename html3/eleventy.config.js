import { rm } from 'node:fs/promises';
import anchor from 'markdown-it-anchor';
import { renderChart } from './lib/chart-ssr.js';
import { REGISTERED_SERIES } from './site/registered-series.js';

const ASSETS = '_site/assets';

export default function (eleventyConfig) {
  eleventyConfig.amendLibrary('md', (md) =>
    md.use(anchor, { slugify: eleventyConfig.getFilter('slugify') }));

  eleventyConfig.addPairedShortcode('echart', (body, height = '350px') =>
    renderChart(body, height, REGISTERED_SERIES));

  // Eleventy does not bundle, and --serve rebuilds pages only, so the bundle is
  // built here on every build and the sources are watched. --production makes
  // bun resolve lit's production export instead of its dev build. bun does not
  // clean its outdir, so stale hashed chunks are removed first.
  eleventyConfig.on('eleventy.before', async () => {
    await rm(ASSETS, { recursive: true, force: true });
    await Bun.$`bun build site/app.js --production --splitting --outdir ${ASSETS} --chunk-naming [name]-[hash].js`.quiet();
  });
  eleventyConfig.addWatchTarget('lib/');
  eleventyConfig.addWatchTarget('site/');

  eleventyConfig.addPassthroughCopy({
    'node_modules/@awesome.me/webawesome/dist-cdn/styles': 'wa/styles',
  });

  return {
    dir: { input: 'md', includes: '../_includes', output: '_site' },
  };
}
