// <app-echart> -- an ECharts option in, a themed chart out.
//
// Separate from the markdown element so a pre-rendered page can import this
// alone. Those pages have their HTML already and never parse markdown, so
// nothing here reaches for `marked` and the bundler leaves it out.
//
// An option reaches a chart two ways:
//
//   config   a URI-encoded string, written by the markdown renderer from an
//            ```echarts fence. Parsed with parseChartOption, which falls back
//            to Function() -- an eval, and safe only because the document was
//            authored by whoever runs the site.
//   option   a plain object, set as a property. Nothing is parsed and nothing
//            is evaluated, so this is the one to use for a chart built from
//            data the site did not write -- a capture file someone uploaded,
//            for instance.
//
// `option` wins when both are set.

import { LitElement, html, css, isServer } from 'lit';

// <app-echart> renders its error as a <wa-callout> inside its own shadow root.
// Nothing scans for that, so the component has to be pulled in deliberately or
// it upgrades to nothing and renders as inline text.
import '@awesome.me/webawesome/dist/components/callout/callout.js';

import { CHART_TAG, seriesTypesOf, withDefaults, parseChartOption } from './chart-option.js';
import { isDark, watchScheme } from './scheme.js';

// --- the chart provider ------------------------------------------- //
// Which ECharts build to draw with is the site's decision, not this file's: a
// tree-shaken ECharts only knows the chart types it was built with, and which
// types matter depends on what the site's documents draw. So the site hands one
// over and this module stays out of it.
//
// A chart provider module exports:
//
//   init(el, theme)     an ECharts instance, as echarts.init
//   REGISTERED_SERIES   Set<string>, the series types it can draw
//
// The loader is a function returning a promise for that module -- normally a
// bare `() => import('./charts.js')`. Keeping the import() expression in the
// site's own module is what lets a bundler give ECharts its own chunk, so it
// does not land in the entry and load before a chart is on screen.

let loadChartProvider;

/** Names the chart provider a page draws with. Call before the first chart renders. */
export function configureCharts(loader) {
  loadChartProvider = loader;
}

/**
 * A tree-shaken ECharts draws nothing for a series type it was not built with,
 * and says nothing about why. Turn that into an error the page can show.
 */
function assertRegistered(option, registered) {
  const unknown = seriesTypesOf(option).filter((t) => !registered.has(t));
  if (unknown.length) {
    throw new Error(
      `series type not in this build: ${unknown.join(', ')}. `
      + `Built with: ${[...registered].join(', ')}.`);
  }
}

class AppEChart extends LitElement {
  static properties = {
    config: { type: String },
    // Attribute off: an object cannot round-trip through one, and quietly
    // JSON-parsing an attribute here would put the eval back by another name.
    option: { attribute: false },
    height: { type: String },
    error:  { state: true },
  };

  // Tokens inherit through the shadow boundary even though selectors do not,
  // so the fallbacks here are only for use outside a Web Awesome page.
  static styles = css`
    :host { display: block; width: 100%; margin-block: var(--wa-space-l, 1.5rem); }
    .chart { width: 100%; }
  `;

  #chart;
  #observer;
  #unwatch;
  #echarts;
  #resolved;

  constructor() {
    super();
    this.config = '';
    this.option = undefined;
    this.height = '350px';
    this.error = '';
  }

  render() {
    if (this.error) {
      return html`
        <wa-callout variant="danger">
          <strong>ECharts error</strong><br>${this.error}
        </wa-callout>`;
    }
    // The server emits exactly this: an empty box at the final height, so the
    // page does not reflow when the chart arrives.
    return html`<div class="chart" style="height: ${this.height};"></div>`;
  }

  connectedCallback() {
    super.connectedCallback();
    if (isServer) return;
    this.#unwatch = watchScheme(() => this.#retheme());
    // Re-attaching after a move: the first update has already run and
    // disconnectedCallback disposed the chart, so nothing else would rebuild it.
    if (this.hasUpdated && !this.#chart) this.#init();
  }

  // Clearing here rather than in updated() means render() has already swapped
  // the callout back for a chart box by the time the rebuild looks for one.
  willUpdate(changed) {
    if (changed.has('option') || changed.has('config')) this.error = '';
  }

  // All building happens here, including the first, because a separate
  // firstUpdated() would run alongside the initial `option` change and build
  // twice. Narrow on purpose: rebuilding for any changed property would loop,
  // since a failed build sets `error`, which is itself a change.
  updated(changed) {
    super.updated(changed);
    if (isServer) return;
    if (!changed.has('option') && !changed.has('config') && !changed.has('height')) return;
    // A new option object is a new chart. Rebuilding rather than merging keeps
    // this honest: ECharts' setOption merges by default, so feeding it a
    // smaller option would leave the previous one's series behind.
    this.#resolved = undefined;
    this.#teardown();
    this.#init();
  }

  async #init() {
    const el = this.renderRoot.querySelector('.chart');
    if (!el) return;
    try {
      // Resolved once and kept. Re-parsing on every theme flip would re-run the
      // eval in parseChartOption, which should happen exactly as often as
      // strictly needed.
      this.#resolved ??= this.option
        ?? (this.config ? parseChartOption(decodeURIComponent(this.config)) : undefined);
      if (!this.#resolved) return;   // nothing to draw yet

      // Deliberately late, and its own chunk: nothing downloads a charting
      // library until a chart is actually on screen.
      if (!loadChartProvider) {
        throw new Error('no chart provider: call configureCharts() before rendering');
      }
      if (!this.#echarts) this.#echarts = await loadChartProvider();
      assertRegistered(this.#resolved, this.#echarts.REGISTERED_SERIES);

      // A theme is fixed at init, so following the page means building again.
      this.#chart = this.#echarts.init(el, isDark() ? 'dark' : undefined);
      this.#chart.setOption(withDefaults(this.#resolved));

      this.#observer = new ResizeObserver(() => this.#chart?.resize());
      this.#observer.observe(el);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  #retheme() {
    this.#teardown();
    this.#init();
  }

  #teardown() {
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#chart?.dispose();
    this.#chart = undefined;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#unwatch?.();
    this.#unwatch = undefined;
    this.#teardown();
  }
}
customElements.define(CHART_TAG, AppEChart);
