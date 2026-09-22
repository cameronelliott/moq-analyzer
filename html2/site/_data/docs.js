// The documents, as data, so live.11ty.js can paginate one live page per one.
//
// Only metadata -- slug, title, and where the markdown will be served from. The
// body is deliberately not here: the live page's whole job is to fetch that at
// runtime and render it in the browser.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createMarkdownRenderer, titleOf } from '../../lib/markdown.js';

const MD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'md');
const renderer = createMarkdownRenderer();

export default function () {
  return readdirSync(MD_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const slug = file.replace(/\.md$/, '');
      const { headings } = renderer.render(readFileSync(join(MD_DIR, file), 'utf8'));
      // Parsed at build only for the <title> and the header. The prose on a
      // live page still comes from the browser's own render.
      return { slug, file, title: titleOf(headings), src: `/src/${file}` };
    });
}
