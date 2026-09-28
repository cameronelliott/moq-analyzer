// Our own markdown files to HTML, and the placeholders in them filled.
//
// One pure function of its text, with no Bun-only and no DOM imports, so the
// browser runs it now and a Bun script can write static pages with it later.
//
// marked does not sanitize. That is fine for pages/*.md, which we write, and
// wrong for anything else: text from a manifest or an mlog goes through the
// `html` template instead, never through here.
//
// A page marks where data goes with raw HTML on its own line, blank lines
// around it:
//   <div data-block="name"></div>     filled by fillBlocks() with a SafeHtml
//   <app-echart data-chart="name">     given its option by mountCharts()

import { Marked } from 'marked';
import { html, trustedMarkup, type SafeHtml } from './html';

const parser = new Marked({ gfm: true });

export function markdown(src: string): SafeHtml {
  return trustedMarkup(parser.parse(src, { async: false }));
}

const BLOCK = /<div data-block="([^"]+)"><\/div>/g;

/**
 * Puts each block into its placeholder. A placeholder with no block, or a
 * block with no placeholder, throws: the page and its code disagree.
 */
export function fillBlocks(page: SafeHtml, blocks: Readonly<Record<string, SafeHtml>>): SafeHtml {
  const used = new Set<string>();
  const text = page.text.replace(BLOCK, (_, name: string) => {
    const block = Object.hasOwn(blocks, name) ? blocks[name] : undefined;
    if (!block) throw new Error(`no block for placeholder data-block="${name}"`);
    used.add(name);
    return html`<div data-block="${name}">${block}</div>`.text;
  });
  const stray = Object.keys(blocks).filter((name) => !used.has(name));
  if (stray.length) throw new Error(`no placeholder for block ${stray.join(', ')}`);
  return trustedMarkup(text);
}
