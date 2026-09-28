// <app-echart> -- an ECharts option in, a themed chart out. From
// ../html3/lib/chart-element.js, less the config-string attribute (an eval) and
// the build-time SVG it used to draw over.
//
// Set the option as a property: `el.option = {...}`. Nothing is parsed and
// nothing is evaluated, so it is safe for charts built from mlog data. A new
// option object is a new chart.
//
//   <app-echart height="150px" variant="card"></app-echart>

import { LitElement, css, html, type PropertyValues } from 'lit';
import type { EChartsOption } from 'echarts';
import type { EChartsType } from 'echarts/core';

// The error renders as a <wa-callout> inside the shadow root. Nothing scans for
// that, so it is imported here, or it upgrades to nothing.
import '@awesome.me/webawesome/dist/components/callout/callout.js';

import { CHART_TAG, assertRegistered, withDefaults } from './chart-option';
import { REGISTERED_SERIES, init } from './charts';
import { isDark, watchScheme } from './dark-light-scheme';

export class AppEChart extends LitElement {
  static override properties = {
    // Attribute off: an object cannot round-trip through one.
    option: { attribute: false },
    height: { type: String },
    // Which page defaults apply: 'prose' or 'card'. See withDefaults.
    variant: { type: String },
    error: { state: true },
  };

  // `declare`, not initialisers: a class field would shadow Lit's accessor.
  declare option: EChartsOption | undefined;
  declare height: string;
  declare variant: string;
  declare error: string;

  // Tokens inherit through the shadow boundary even though selectors do not,
  // so the fallbacks here are only for use outside a Web Awesome page.
  static override styles = css`
    :host { display: block; width: 100%; margin-block: var(--wa-space-l, 1.5rem); }
    .chart { width: 100%; }
  `;

  #chart: EChartsType | undefined;
  #observer: ResizeObserver | undefined;
  #unwatch: (() => void) | undefined;

  constructor() {
    super();
    this.option = undefined;
    this.height = '350px';
    this.variant = 'prose';
    this.error = '';
  }

  override render() {
    if (this.error) {
      return html`
        <wa-callout variant="danger">
          <strong>ECharts error</strong><br>${this.error}
        </wa-callout>`;
    }
    return html`<div class="chart" style="height: ${this.height};"></div>`;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.#unwatch = watchScheme(() => this.#rebuild());
    // Re-attaching after a move: the first update has already run and
    // disconnectedCallback disposed the chart, so nothing else would rebuild it.
    if (this.hasUpdated && !this.#chart) this.#build();
  }

  // Clearing here rather than in updated() means render() has already swapped
  // the callout back for a chart box by the time the rebuild looks for one.
  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has('option')) this.error = '';
  }

  // All building happens here, including the first. Narrow on purpose:
  // rebuilding for any changed property would loop, since a failed build sets
  // `error`, which is itself a change.
  override updated(changed: PropertyValues<this>) {
    super.updated(changed);
    if (changed.has('option') || changed.has('height') || changed.has('variant')) this.#rebuild();
  }

  // Rebuild rather than merge: ECharts' setOption merges by default, so a
  // smaller option would leave the previous one's series behind. And a theme
  // is fixed at init, so following the page's scheme means building again.
  #rebuild() {
    this.#teardown();
    this.#build();
  }

  #build() {
    const el = this.renderRoot.querySelector<HTMLElement>('.chart');
    if (!el || !this.option) return;
    try {
      assertRegistered(this.option, REGISTERED_SERIES);
      const dark = isDark();
      this.#chart = init(el, dark ? 'dark' : undefined);
      this.#chart.setOption(withDefaults(this.option, this.variant, { dark }));
      this.#observer = new ResizeObserver(() => this.#chart?.resize());
      this.#observer.observe(el);
    } catch (err) {
      this.#teardown();
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  #teardown() {
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#chart?.dispose();
    this.#chart = undefined;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#unwatch?.();
    this.#unwatch = undefined;
    this.#teardown();
  }
}

customElements.define(CHART_TAG, AppEChart);

/** Gives each `<app-echart data-chart="id">` under root its option from charts. */
export function mountCharts(root: ParentNode, charts: Readonly<Record<string, EChartsOption>>): void {
  for (const el of root.querySelectorAll('app-echart')) {
    const id = el.dataset.chart;
    if (id !== undefined && id in charts) el.option = charts[id];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-echart': AppEChart;
  }
}
