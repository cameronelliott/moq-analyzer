// <app-markdown> -- a markdown string in, light-DOM HTML out -- and the sidebar
// binding that goes with it.
//
// Separate from the chart element because it is the half that carries `marked`.
// A pre-rendered page has its HTML already and imports only the chart element,
// which is what keeps a markdown parser out of that bundle. A page that renders
// markdown while it runs -- an analyzer showing numbers that change as a file
// is read -- imports this and pays for it deliberately.

import { LitElement, html, isServer } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { createMarkdownRenderer } from './markdown.js';

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
 * Only for pages that render markdown as they run. A pre-rendered page has its
 * sidebar in the HTML already, built by navHtml() from the same headings.
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
