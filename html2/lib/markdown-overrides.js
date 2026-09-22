// The two renderer overrides, as a plain `marked` extension, with no `marked`
// import of its own.
//
// This module exists so the server and the browser configure the SAME renderer
// from the SAME source. The server builds its own Marked instance around these;
// the browser registers them on the singleton <wa-markdown> shares via
// WaMarkdown.getMarked(). Two configuration sites, one definition -- which is
// what keeps a document rendering identically either side.
//
// Heading collection is a callback rather than a module-level array on purpose.
// <wa-markdown> shares one Marked instance across every instance on the page, so
// anything stateful in here would interleave between islands.

export const CHART_TAG = 'app-echart';
export const CHART_LANG = 'echarts';

/**
 * @param onHeading called as ({ depth, id, text }) for each heading, in document
 *   order. The server passes a collector; an island passes nothing.
 */
export function createOverrides({ onHeading } = {}) {
  return {
    renderer: {
      code({ text, lang }) {
        if (lang !== CHART_LANG) return false;   // false = use the default renderer
        const config = encodeURIComponent(text.trim());
        return `<${CHART_TAG} config="${config}"></${CHART_TAG}>\n`;
      },
      // A shorthand method, not an arrow, so `this` is the renderer and
      // `this.parser` exists.
      heading({ tokens, depth }) {
        const markup = this.parser.parseInline(tokens);
        const text = markup.replace(/<[^>]+>/g, '');   // e.g. <code> in a heading
        const id = text
          .toLowerCase()
          .replace(/[^\w]+/g, '-')
          .replace(/^-+|-+$/g, '');
        onHeading?.({ depth, id, text });
        return `<h${depth} id="${id}">${markup}</h${depth}>\n`;
      },
    },
  };
}
