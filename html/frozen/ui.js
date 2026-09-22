// FROZEN. A copy of lib/ui.js as it stood at the first extraction, kept only so
// experiment 5 and experiment 6 still run. Current code is lib/chart-element.js,
// lib/markdown-element.js and lib/scheme.js, which is this file split three ways
// so a page can import the chart element without the markdown parser.
//
// Differences from current, all deliberate, none worth back-porting:
//   - imports the whole of ECharts from the page's importmap, rather than
//     taking a tree-shaken chart provider through configureCharts()
//   - no `option` property: a chart can only come from a `config` attribute
//   - installSchemeToggle swaps a <wa-icon> name; current pages do it in CSS
//
// Do not fix bugs here; fix them in lib/.
//
// ---
//
// The half of a markdown-charts page that needs a browser.
//
// Two custom elements and the two bits of page wiring they expect. Importing
// this file registers <app-echart> and <app-markdown> as a side effect, so a
// page that wants them only has to import it.
//
// Bare specifiers ('lit', 'echarts', 'webawesome/') resolve through the page's
// importmap; a page that uses this module has to carry one.

import { LitElement, html, css, isServer } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// The Web Awesome loader in <head> finds wa-* elements by scanning the
// document, and a shadow root is not in that scan. <app-echart> renders its
// error as a <wa-callout> inside its own shadow root, so that one has to be
// registered deliberately or it upgrades to nothing and renders as inline text.
import 'webawesome/components/callout/callout.js';

import { createMarkdownRenderer, withDefaults, parseChartOption } from './doc.js';

// --- the page's color scheme -------------------------------------- //
// Web Awesome drives light/dark with explicit classes on <html>, so anything
// that cannot be themed with CSS alone -- a canvas, for instance -- has to
// notice the change. Watching the class list means noticing is the widget's
// job: nothing has to announce the flip, and nothing has to be told where to
// listen.

/** True while the page is showing Web Awesome's dark scheme. */
export const isDark = () => document.documentElement.classList.contains('wa-dark');

/** Calls back when <html> flips light/dark. Returns a disposer. */
export function watchScheme(onChange) {
  let dark = isDark();
  const observer = new MutationObserver(() => {
    // Two class mutations per flip, and other code may touch the list for
    // reasons of its own, so report the transition rather than the record.
    if (dark === isDark()) return;
    dark = !dark;
    onChange();
  });
  observer.observe(document.documentElement, { attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/**
 * Wires a button to flip the scheme. It sets two classes and swaps its own
 * icon, and stops there -- whatever needs to follow is watching.
 */
export function installSchemeToggle(button) {
  button.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.classList.toggle('wa-dark');
    root.classList.toggle('wa-light', !dark);
    const icon = button.querySelector('wa-icon');
    if (icon) icon.name = dark ? 'sun' : 'moon';
  });
}

// --- <app-echart> ------------------------------------------------- //

class AppEChart extends LitElement {
  static properties = {
    config: { type: String },
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
  #option;

  constructor() {
    super();
    this.config = '';
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

  firstUpdated(changed) {
    super.firstUpdated(changed);
    if (isServer) return;
    this.#init();
  }

  connectedCallback() {
    super.connectedCallback();
    if (isServer) return;
    this.#unwatch = watchScheme(() => this.#retheme());
    // Re-attaching after a move: firstUpdated has already run and
    // disconnectedCallback disposed the chart, so nothing else would rebuild it.
    if (this.hasUpdated && !this.#chart) this.#init();
  }

  async #init() {
    const el = this.renderRoot.querySelector('.chart');
    if (!el || !this.config) return;
    try {
      // Parsed once and kept. Re-parsing on every theme flip would re-run the
      // eval in parseChartOption, which should happen exactly as often as
      // strictly needed.
      this.#option ??= parseChartOption(decodeURIComponent(this.config));
      if (!this.#echarts) this.#echarts = await import('echarts');  // browser only

      // A theme is fixed at init, so following the page means building again.
      this.#chart = this.#echarts.init(el, isDark() ? 'dark' : undefined);
      this.#chart.setOption(withDefaults(this.#option));

      this.#observer = new ResizeObserver(() => this.#chart?.resize());
      this.#observer.observe(el);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  #retheme() {
    if (!this.#chart) return;   // never initialised, or failed; nothing to redo
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
customElements.define('app-echart', AppEChart);

// --- <app-markdown> ----------------------------------------------- //

const markdown = createMarkdownRenderer();

class AppMarkdown extends LitElement {
  static properties = { content: { type: String } };

  // Light DOM, so wa-prose's descendant selectors reach the generated
  // headings, lists and tables. Content still arrives as a property and
  // render() is still synchronous, which is what keeps a server render open.
  createRenderRoot() { return this; }

  #body = '';
  #headings = [];

  constructor() {
    super();
    this.content = '';
  }

  // Parsing here rather than in render() keeps render() a pure read and the
  // document parsed exactly once per change, even though two things want the
  // result.
  willUpdate(changed) {
    if (!changed.has('content')) return;
    ({ body: this.#body, headings: this.#headings } =
      this.content ? markdown.render(this.content) : { body: '', headings: [] });
  }

  render() {
    if (!this.#body) return html``;
    return html`${unsafeHTML(this.#body)}`;
  }

  updated(changed) {
    super.updated(changed);
    if (isServer || !changed.has('content')) return;
    // Announced after the ids exist in the DOM, so a listener can link to them
    // immediately.
    this.dispatchEvent(new CustomEvent('headings', {
      detail: this.#headings,
      bubbles: true,
      composed: true,
    }));
  }
}
customElements.define('app-markdown', AppMarkdown);

// --- the sidebar --------------------------------------------------- //

/**
 * Fills `nav` from the headings `markdownEl` reports, so the sidebar is
 * derived from the document rather than maintained beside it. Adding a section
 * adds a link; renaming one renames the link and its anchor together, because
 * both come from the same slug.
 *
 * Call this before setting `content`, or the first report is missed.
 */
export function bindNav(nav, markdownEl, { depth = 2 } = {}) {
  markdownEl.addEventListener('headings', (e) => {
    nav.replaceChildren(...e.detail
      .filter((h) => h.depth === depth)
      .map(({ id, text }) => {
        const a = document.createElement('a');
        a.href = `#${id}`;
        a.dataset.drawer = 'close';   // wa-page closes the mobile drawer on click
        a.textContent = text;
        return a;
      }));
  });
}
