// Build-time chart rendering: a `{% echart %}` body becomes an <app-echart>
// carrying its config, with a static SVG of the chart inside it as fallback
// content. The page shows the SVG with JS off; the element replaces it with an
// interactive canvas once its module loads.
//
// The build may import all of echarts freely -- tree-shaking only matters for
// what ships to the browser.

import { createHash } from 'node:crypto';
import * as echarts from 'echarts';
import { LegacyGridContainLabel } from 'echarts/features';
import { CHART_TAG, assertRegistered, parseChartOption, withDefaults } from './chart-option.js';

// withDefaults sets grid.containLabel, which ECharts 6 ignores without this.
echarts.use(LegacyGridContainLabel);

// SSR needs pixels. The SVG gets a viewBox, so this sets the aspect ratio and
// text scale rather than the size on the page: it stretches to the column.
const SSR_WIDTH = 720;

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * Throws if the body parses in neither dialect, or draws a series type the
 * browser's ECharts build lacks. Either stops the build.
 */
export function renderChart(body, height, registered) {
  const src = body.trim();
  const parsed = parseChartOption(src);
  assertRegistered(parsed, registered);
  const option = withDefaults(parsed);

  const chart = echarts.init(null, null, {
    renderer: 'svg',
    ssr: true,
    width: SSR_WIDTH,
    height: parseInt(height, 10),
  });
  let svg;
  try {
    // No animation: SSR draws one frame, and it must be the final one.
    chart.setOption({ ...option, animation: false });
    svg = chart.renderToSVGString({ useViewBox: true });
  } finally {
    chart.dispose();
  }

  svg = svg
    // Drop the pixel size so the viewBox scales it to the column.
    .replace(/^<svg width="\d+" height="\d+"/, '<svg')
    // zrender prefixes ids and classes from a process-wide instance counter,
    // so the same page would come out different on every rebuild. Key them
    // on the source instead.
    .replace(/\bzr\d+-/g, `ec${createHash('sha1').update(src).digest('hex').slice(0, 8)}-`)
    // Its <style> block has blank lines, and markdown-it ends an HTML block at
    // the first one; everything after it becomes a paragraph.
    .replace(/\n[ \t]*(?=\n)/g, '');

  // markdown-it only treats this as an HTML block if the open tag is alone on
  // its line; otherwise it wraps the SVG in <p>.
  return `<${CHART_TAG} config="${escapeAttr(encodeURIComponent(src))}" height="${escapeAttr(height)}">\n${svg}\n</${CHART_TAG}>`;
}
